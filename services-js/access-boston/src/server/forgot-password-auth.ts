/* eslint no-console: 0 */

import { Server as HapiServer } from 'hapi';
import SamlAuth, { makeSamlAuth } from './services/SamlAuth';
import SamlAuthFake from './services/SamlAuthFake';

import SessionAuth from './SessionAuth';

const FORGOT_METADATA_PATH = '/metadata-forgot.xml';
const FORGOT_ASSERT_PATH = '/assert-forgot';
const FORGOT_REDIRECT_PATH = '/forgot-redirect';
const FAKE_FORGOT_LOGIN_FORM_PATH = '/fake-forgot-login-form';

const FORGOT_COOKIE_AUTH_DECORATOR = 'forgotCookieAuth';

interface Paths {
  forgotPath: string;
}

/**
 * Adds routes and handling for the separate "forgot password" SAML app.
 *
 * Forgot password is treated differently from normal login because you only
 * auth with an MFA token. That difference means that the Ping configuration has
 * to separate it as a different app.
 *
 * We use a different everything from normal login to reduce the chances that we
 * "cross streams" and allow forgot password auth to authorize normal login
 * operations and vice-versa.
 */
export async function addForgotPasswordAuth(
  server: HapiServer,
  { forgotPath }: Paths
) {
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.FORGOT_COOKIE_PASSWORD
  ) {
    throw new Error('Must set $FORGOT_COOKIE_PASSWORD in production');
  }

  server.auth.strategy('forgot-password', 'cookie', {
    // Fallback password so this runs in dev / test w/o extra configuration.
    password:
      process.env.FORGOT_COOKIE_PASSWORD || 'mnNNmmjr9Xfe9rWWqatKK7zesS9vvhdz',
    cookie: 'fsid',
    redirectTo: FORGOT_REDIRECT_PATH,
    isSecure: process.env.NODE_ENV === 'production',
    ttl: 60 * 60 * 1000,
    clearInvalid: true,
    keepAlive: false,
    requestDecoratorName: FORGOT_COOKIE_AUTH_DECORATOR,
  });

  // For the forgot password workflow, we use a separate SAML app because the
  // backend auth setup has to require the MFA at all times for these logins.
  let samlAuth: SamlAuth;

  if (
    process.env.NODE_ENV === 'production' ||
    process.env.SAML_IN_DEV === 'true'
  ) {
    const publicHost = process.env.PUBLIC_HOST;
    const metadataUrl = `https://${publicHost}${FORGOT_METADATA_PATH}`;
    const assertUrl = `https://${publicHost}${FORGOT_ASSERT_PATH}`;

    samlAuth = await makeSamlAuth(
      {
        metadataPath: './saml-forgot-metadata.xml',
        serviceProviderCertPath: './service-provider-forgot.crt',
        serviceProviderKeyPath: './service-provider-forgot.key',
      },
      {
        metadataUrl,
        assertUrl,
      },
      ''
    );
  } else {
    samlAuth = new SamlAuthFake({
      assertUrl: FORGOT_ASSERT_PATH,
      loginFormUrl: FAKE_FORGOT_LOGIN_FORM_PATH,
      userId: process.env.SAML_FAKE_USER_ID,
    }) as any;
  }

  server.route({
    path: FORGOT_METADATA_PATH,
    method: 'GET',
    options: { auth: false },
    handler: (_, h) =>
      h.response(samlAuth.getMetadata()).type('application/xml'),
  });

  // Same as above, just for the forgot password sessions.
  server.route({
    path: FORGOT_REDIRECT_PATH,
    method: 'GET',
    options: { auth: false },
    handler: async (_, h) => h.redirect(await samlAuth.makeLoginUrl()),
  });

  // Fake login forms we can use in dev without needing the SAML SSO
  // infrastructure configured.
  if (process.env.NODE_ENV !== 'production') {
    server.route({
      path: FAKE_FORGOT_LOGIN_FORM_PATH,
      method: 'GET',
      options: { auth: false },
      handler: () =>
        `<form action="${FORGOT_ASSERT_PATH}" method="POST">
          <input type="submit" value="Log In" />
         </form>`,
    });
  }

  server.route({
    path: FORGOT_ASSERT_PATH,
    method: 'POST',
    options: {
      auth: false,
      plugins: {
        crumb: false,
      },
    },
    handler: async (request, h) => {
      const assertResult = await samlAuth.handlePostAssert(
        request.payload as string
      );

      if (assertResult.type !== 'login') {
        throw new Error(
          `Unexpected assert result in POST handler: ${assertResult.type}`
        );
      }

      // TODO(finh): Will probably need to change this around for the different
      // values we'll get from the separate login process.
      const { nameId, sessionIndex, groups } = assertResult;

      new SessionAuth(request, FORGOT_COOKIE_AUTH_DECORATOR).set({
        nameId,
        sessionIndex,
        groups,
      });

      return h.redirect(forgotPath);
    },
  });

  server.route({
    path: FORGOT_ASSERT_PATH,
    method: 'GET',
    options: { auth: false },
    handler: async () => {
      throw new Error(`Unexpected GET request to ${FORGOT_ASSERT_PATH}`);
    },
  });
}
