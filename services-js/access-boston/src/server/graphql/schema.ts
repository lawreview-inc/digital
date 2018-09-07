/**
 * @file This file defines the GraphQL schema and resolvers for our server.
 *
 * Run `npm run generate-graphql-schema` to use `ts2gql` to turn this file into
 * the `schema.graphql` file that can be consumed by this and other tools.
 *
 * The output is generated in the “graphql” directory in the package root so
 * that it can be `readFileSync`’d from both `build` (during dev and production)
 * and `src` (during test).
 */
import fs from 'fs';
import path from 'path';

import { makeExecutableSchema } from 'graphql-tools';
import { Resolvers } from '@cityofboston/graphql-typescript';
import AppsRegistry from '../services/AppsRegistry';
import SamlAuth from '../services/SamlAuth';
import SessionAuth from '../SessionAuth';
import IdentityIq, { LaunchedWorkflowResponse } from '../services/IdentityIq';

/** @graphql schema */
export interface Schema {
  query: Query;
  mutation: Mutation;
}

export interface Query {
  account: Account;
  apps: Apps;
  workflow(args: { caseId: string }): Workflow;
}

export interface Mutation {
  changePassword(args: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }): Workflow;
}

export interface Account {
  employeeId: string;
}

export interface Apps {
  categories: AppCategory[];
}

export interface AppCategory {
  title: string;
  showIcons: boolean;
  requestAccessUrl: string | null;

  apps: App[];
}

export interface App {
  title: string;
  url: string;
  iconUrl: string | null;
  description: string;
}

export enum WorkflowStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN',
}

export enum ChangePasswordError {
  NEW_PASSWORDS_DONT_MATCH = 'NEW_PASSWORDS_DONT_MATCH',
  CURRENT_PASSWORD_WRONG = 'CURRENT_PASSWORD_WRONG',
  NEW_PASSWORD_POLICY_VIOLATION = 'NEW_PASSWORD_POLICY_VIOLATION',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface Workflow {
  caseId: string | null;
  status: WorkflowStatus;
  messages: string[];
  error: ChangePasswordError | null;
}

// This file is built by the "generate-graphql-schema" script from
// the above interfaces.
const schemaGraphql = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'graphql', 'schema.graphql'),
  'utf-8'
);

export interface Context {
  sessionAuth: SessionAuth;
  appsRegistry: AppsRegistry;
  samlAuth: SamlAuth;
  identityIq: IdentityIq;
}

const queryRootResolvers: Resolvers<Query, Context> = {
  account: (_root, _args, { sessionAuth }) => {
    const session = sessionAuth.get();

    return {
      employeeId: session.nameId,
    };
  },

  apps: (_root, _args, { appsRegistry, sessionAuth }) => ({
    categories: appsRegistry
      .appsForGroups(sessionAuth.get().groups)
      .map(({ apps, icons, showRequestAccessLink, title }) => ({
        title,
        showIcons: icons,
        requestAccessUrl: showRequestAccessLink ? '#' : null,
        apps: apps.map(({ title, iconUrl, url, description }) => ({
          title,
          iconUrl: iconUrl || null,
          url,
          description,
        })),
      })),
  }),

  workflow: async (_root, { caseId }, { identityIq }) =>
    launchedWorkflowResponseToWorkflow(await identityIq.fetchWorkflow(caseId)),
};

const mutationResolvers: Resolvers<Mutation, Context> = {
  changePassword: async (
    _root,
    { currentPassword, newPassword, confirmPassword },
    { identityIq, sessionAuth }
  ) => {
    if (newPassword !== confirmPassword) {
      return {
        caseId: null,
        error: ChangePasswordError.NEW_PASSWORDS_DONT_MATCH,
        messages: [],
        status: WorkflowStatus.ERROR,
      };
    }

    const workflowResponse = await identityIq.changePassword(
      sessionAuth.get().nameId,
      currentPassword,
      newPassword
    );

    return launchedWorkflowResponseToWorkflow(workflowResponse);
  },
};

export default makeExecutableSchema({
  typeDefs: [schemaGraphql],
  // We typecheck our own resolvers, so we set this as "any". Otherwise our
  // precise "args" typing conflicts with the general {[argument: string]: any}
  // type that the library gives them.
  resolvers: [
    {
      Query: queryRootResolvers,
      Mutation: mutationResolvers,
    },
  ] as any,
  allowUndefinedInResolve: false,
});

function launchedWorkflowResponseToWorkflow(
  workflowResponse: LaunchedWorkflowResponse
): Workflow {
  let status: WorkflowStatus;

  switch (workflowResponse.completionStatus) {
    case 'Error':
      status = WorkflowStatus.ERROR;
      break;
    case 'Success':
      status = WorkflowStatus.SUCCESS;
      break;
    default:
      status = WorkflowStatus.UNKNOWN;
  }

  const messages = workflowResponse.messages;
  let error: ChangePasswordError | null = null;

  if (status === WorkflowStatus.ERROR) {
    if (messages.find(m => m === 'Current Password Check Failure')) {
      error = ChangePasswordError.CURRENT_PASSWORD_WRONG;
    } else if (
      messages.find(m => m.includes('Password Policy Compliance Failure'))
    ) {
      error = ChangePasswordError.NEW_PASSWORD_POLICY_VIOLATION;
    } else {
      error = ChangePasswordError.UNKNOWN_ERROR;
    }
  }

  return {
    caseId: workflowResponse.id,
    messages,
    error,
    status,
  };
}