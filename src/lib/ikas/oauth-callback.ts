import {
  consumeOAuthStateSession,
  saveInstallationSession,
  type SessionHandle,
} from "../session";
import {
  isValidOAuthState,
  OAUTH_STATE_FUTURE_SKEW_MS,
  OAUTH_STATE_TTL_MS,
  readOAuthStateCreatedAt,
  type OAuthStateConsumeResult,
} from "./oauth-state-store";
import { isValidStoreName } from "./store-name";
import { TokenStoreError, type StoredIkasToken } from "./token-store";
import type { OAuthFailureReason } from "./oauth-failure";

export { OAUTH_STATE_FUTURE_SKEW_MS, OAUTH_STATE_TTL_MS } from "./oauth-state-store";

export const OAUTH_CALLBACK_STAGES = [
  "oauth_config",
  "state_consume",
  "session_state_validation",
  "token_exchange",
  "app_context_query",
  "token_persist",
  "installation_session_save",
  "success_redirect",
] as const;

export type OAuthCallbackStage = (typeof OAUTH_CALLBACK_STAGES)[number];
export type OAuthCallbackOutcome = "started" | "success" | "failure";

export type OAuthCallbackLogEvent = {
  event: "ikas_oauth_callback";
  correlationId: string;
  stage: OAuthCallbackStage;
  outcome: OAuthCallbackOutcome;
  reason?: OAuthFailureReason;
};

export type OAuthCallbackLogger = {
  info(event: OAuthCallbackLogEvent): void;
  error(event: OAuthCallbackLogEvent): void;
};

export type OAuthCallbackSession = SessionHandle & {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
};

export type OAuthCallbackInput = {
  code?: string | null;
  state?: string | null;
  storeName?: string | null;
  redirectUri: string;
  successBaseUrl: string;
};

type OAuthConfiguration = {
  clientId: string;
  clientSecret: string;
};

type OAuthTokenResponse = {
  ok: boolean;
  status: number;
  data: unknown;
};

export type OAuthCallbackDependencies = {
  getOAuthConfig(): OAuthConfiguration;
  consumeOAuthState(state: string): Promise<OAuthStateConsumeResult>;
  getSession(): Promise<OAuthCallbackSession>;
  exchangeToken(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    storeName: string;
  }): Promise<OAuthTokenResponse>;
  queryAppContext(accessToken: string): Promise<Response>;
  persistToken(token: StoredIkasToken): Promise<unknown>;
  createCorrelationId?: () => string;
  now?: () => number;
  logger?: OAuthCallbackLogger;
};

export type OAuthCallbackResult =
  | {
      ok: true;
      correlationId: string;
      redirectUrl: URL;
      authorizedAppId: string;
      storeName: string;
    }
  | {
      ok: false;
      correlationId: string;
      errorId: string;
      reason: OAuthFailureReason;
      storeName: string;
    };

class OAuthCallbackFailure extends Error {
  constructor(readonly reason: OAuthFailureReason) {
    super(reason);
    this.name = "OAuthCallbackFailure";
  }
}

const STAGE_DEFAULT_REASONS: Record<OAuthCallbackStage, OAuthFailureReason> = {
  oauth_config: "oauth_config_missing",
  session_state_validation: "session_save_failed",
  token_exchange: "token_exchange_failed",
  app_context_query: "app_context_http_failed",
  token_persist: "token_persist_failed",
  state_consume: "state_store_unavailable",
  installation_session_save: "session_save_failed",
  success_redirect: "unexpected_error",
};

const consoleLogger: OAuthCallbackLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  error(event) {
    console.error(JSON.stringify(event));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeTenantIdentifier(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function fail(reason: OAuthFailureReason): never {
  throw new OAuthCallbackFailure(reason);
}

async function runStage<T>(
  stage: OAuthCallbackStage,
  correlationId: string,
  logger: OAuthCallbackLogger,
  action: () => T | Promise<T>,
): Promise<T> {
  logger.info({ event: "ikas_oauth_callback", correlationId, stage, outcome: "started" });
  try {
    const result = await action();
    logger.info({ event: "ikas_oauth_callback", correlationId, stage, outcome: "success" });
    return result;
  } catch (error) {
    const reason = error instanceof OAuthCallbackFailure ? error.reason : STAGE_DEFAULT_REASONS[stage];
    logger.error({ event: "ikas_oauth_callback", correlationId, stage, outcome: "failure", reason });
    throw new OAuthCallbackFailure(reason);
  }
}

function parseTokenPayload(data: unknown) {
  if (
    !isRecord(data) ||
    !isNonEmptyString(data.access_token) ||
    !isNonEmptyString(data.refresh_token) ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    fail("token_exchange_failed");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    tokenType: isNonEmptyString(data.token_type) ? data.token_type : undefined,
  };
}

async function parseAppContext(response: Response) {
  if (!response.ok) fail("app_context_http_failed");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    fail("app_context_http_failed");
  }

  if (!isRecord(payload)) fail("app_context_http_failed");
  if (Array.isArray(payload.errors) && payload.errors.length > 0) fail("app_context_graphql_error");
  if (!isRecord(payload.data)) fail("merchant_context_missing");

  const merchant = payload.data.getMerchant;
  if (
    !isRecord(merchant) ||
    !isSafeTenantIdentifier(merchant.id) ||
    typeof merchant.storeName !== "string" ||
    !isValidStoreName(merchant.storeName)
  ) {
    fail("merchant_context_missing");
  }

  const authorizedApp = payload.data.getAuthorizedApp;
  if (!isRecord(authorizedApp) || !isSafeTenantIdentifier(authorizedApp.id)) fail("authorized_app_missing");

  return {
    merchantId: merchant.id,
    merchantStoreName: merchant.storeName,
    authorizedAppId: authorizedApp.id,
  };
}

function isVerifiedDurableToken(value: unknown, expected: StoredIkasToken): value is StoredIkasToken {
  return (
    isRecord(value) &&
    value.authorizedAppId === expected.authorizedAppId &&
    value.merchantId === expected.merchantId &&
    value.storeName === expected.storeName &&
    value.accessToken === expected.accessToken &&
    value.refreshToken === expected.refreshToken &&
    value.tokenType === expected.tokenType &&
    value.expiresAt === expected.expiresAt
  );
}

function persistenceFailureReason(error: unknown): OAuthFailureReason {
  return error instanceof TokenStoreError && error.code === "configuration"
    ? "token_store_unavailable"
    : "token_persist_failed";
}

export async function processIkasOAuthCallback(
  input: OAuthCallbackInput,
  dependencies: OAuthCallbackDependencies,
): Promise<OAuthCallbackResult> {
  const correlationId = dependencies.createCorrelationId ? dependencies.createCorrelationId() : crypto.randomUUID();
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? consoleLogger;
  let attemptedStoreName = "";

  try {
    const oauthConfig = await runStage("oauth_config", correlationId, logger, () => {
      const value = dependencies.getOAuthConfig();
      if (!isNonEmptyString(value.clientId) || !isNonEmptyString(value.clientSecret)) fail("oauth_config_missing");
      return value;
    });

    const stateContext = await runStage("state_consume", correlationId, logger, async () => {
      const code = input.code ?? "";
      const state = input.state ?? "";
      if (
        !code ||
        code.length > 4096 ||
        code.trim() !== code ||
        /[\u0000-\u001f\u007f-\u009f]/.test(code)
      ) {
        fail("callback_invalid");
      }
      if (!state) fail("state_missing");
      if (state.length > 512 || !isValidOAuthState(state)) fail("state_mismatch");

      const consumed = await dependencies.consumeOAuthState(state);
      if (consumed.status === "missing") fail("state_not_found");
      if (consumed.status === "expired") fail("state_expired");
      if (consumed.status === "replayed") fail("state_replayed");
      if (consumed.status !== "consumed") fail("state_store_unavailable");

      const stateIssuedAt = consumed.record.createdAt;
      const stateValidationTime = now();
      if (
        !Number.isSafeInteger(stateIssuedAt) ||
        stateIssuedAt! <= 0 ||
        stateIssuedAt !== readOAuthStateCreatedAt(state) ||
        stateIssuedAt! > stateValidationTime + OAUTH_STATE_FUTURE_SKEW_MS ||
        stateValidationTime - stateIssuedAt! >= OAUTH_STATE_TTL_MS
      ) {
        fail(stateValidationTime - stateIssuedAt! >= OAUTH_STATE_TTL_MS ? "state_expired" : "state_mismatch");
      }
      if (!isValidStoreName(consumed.record.storeName)) fail("invalid_store_name");

      attemptedStoreName = consumed.record.storeName;
      if (input.storeName !== undefined && input.storeName !== null && input.storeName !== attemptedStoreName) {
        fail("invalid_store_name");
      }

      return { code, state, stateIssuedAt, storeName: attemptedStoreName };
    });

    const session = await runStage("session_state_validation", correlationId, logger, async () => {
      const value = await dependencies.getSession();
      const hasCookieState = value.state !== undefined || value.stateIssuedAt !== undefined;
      if (hasCookieState) {
        if (value.state !== stateContext.state || value.stateIssuedAt !== stateContext.stateIssuedAt) {
          fail("state_mismatch");
        }
        if (!value.storeName || !isValidStoreName(value.storeName)) fail("invalid_store_name");
        if (value.storeName !== stateContext.storeName) fail("state_mismatch");
      }
      await consumeOAuthStateSession(value);
      return value;
    });

    const token = await runStage("token_exchange", correlationId, logger, async () => {
      if (!isValidStoreName(stateContext.storeName)) fail("invalid_store_name");
      const response = await dependencies.exchangeToken({
        code: stateContext.code,
        clientId: oauthConfig.clientId,
        clientSecret: oauthConfig.clientSecret,
        redirectUri: input.redirectUri,
        storeName: stateContext.storeName,
      });
      if (!response.ok || response.status < 200 || response.status >= 300) fail("token_exchange_failed");
      return parseTokenPayload(response.data);
    });

    const appContext = await runStage("app_context_query", correlationId, logger, async () => {
      const response = await dependencies.queryAppContext(token.accessToken);
      const value = await parseAppContext(response);
      if (value.merchantStoreName !== stateContext.storeName) fail("merchant_context_missing");
      return value;
    });

    const storeName = stateContext.storeName;

    const storedToken: StoredIkasToken = {
      authorizedAppId: appContext.authorizedAppId,
      merchantId: appContext.merchantId,
      storeName,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      ...(token.tokenType ? { tokenType: token.tokenType } : {}),
      expiresAt: now() + token.expiresIn * 1000,
    };

    await runStage("token_persist", correlationId, logger, async () => {
      try {
        const persistedToken = await dependencies.persistToken(storedToken);
        if (!isVerifiedDurableToken(persistedToken, storedToken)) fail("token_persist_failed");
      } catch (error) {
        if (error instanceof OAuthCallbackFailure) throw error;
        fail(persistenceFailureReason(error));
      }
    });

    await runStage("installation_session_save", correlationId, logger, () =>
      saveInstallationSession(session, {
        authorizedAppId: appContext.authorizedAppId,
        merchantId: appContext.merchantId,
        storeName,
      }),
    );

    const redirectUrl = await runStage("success_redirect", correlationId, logger, () => {
      return new URL("/", input.successBaseUrl);
    });

    return {
      ok: true,
      correlationId,
      redirectUrl,
      authorizedAppId: appContext.authorizedAppId,
      storeName,
    };
  } catch (error) {
    const reason = error instanceof OAuthCallbackFailure ? error.reason : "unexpected_error";
    return {
      ok: false,
      correlationId,
      errorId: correlationId,
      reason,
      storeName: attemptedStoreName,
    };
  }
}
