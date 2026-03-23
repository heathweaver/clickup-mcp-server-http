import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import express, { type Response } from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';

const SCOPES = ['clickup.read', 'clickup.write'] as const;
const DEFAULT_SCOPE = SCOPES.join(' ');
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ClickUp IDs are alphanumeric (and may contain hyphens)
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

type ToolConfig = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResponse>;
};

function ensureId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (!ID_REGEX.test(value.trim())) {
    throw new Error(`${field} must be a valid ClickUp ID (alphanumeric string)`);
  }
  return value.trim();
}

function ensureOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureId(value, field);
}

function ensureNonEmptyArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return value as T[];
}

function ensureObject<T extends Record<string, unknown>>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as T;
}

function ensureString(
  value: unknown,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

function ensureOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureString(value, field);
}

function ensureOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function ensureOptionalIntegerInRange(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function ensureOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function ensureStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function ensureOptionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function ensureIdArray(
  value: unknown,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value.map((item, index) => ensureId(item, `${field}[${index}]`));
}

function buildToolResponse(payload: unknown, isError: boolean): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function idSchema(description: string) {
  return {
    type: 'string',
    description: `${description} Provide the ClickUp ID (alphanumeric string).`,
  };
}

type ClickUpRequestOptions = {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

class ClickUpClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, baseUrl = 'https://api.clickup.com/api/v2') {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get(path: string, query?: Record<string, unknown>) {
    return this.request('GET', path, { query });
  }

  async post(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('POST', path, { body, query });
  }

  async put(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('PUT', path, { body, query });
  }

  async delete(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('DELETE', path, { body, query });
  }

  private async request(method: string, path: string, options: ClickUpRequestOptions = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(`${key}[]`, String(entry));
          }
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.token,
    };

    const init: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && options.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        payload?.err ||
        payload?.error ||
        payload?.ECODE ||
        response.statusText;
      throw new Error(`ClickUp API error (${response.status}): ${message}`);
    }

    return payload;
  }
}

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---------------------------------------------------------------------------
// Persistent OAuth state (file-backed)
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || '/app/data';
mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = join(DATA_DIR, 'oauth-state.json');

type PersistedState = {
  clients: Record<string, OAuthClientInformationFull>;
  authCodes: Record<string, { clientId: string; codeChallenge: string; redirectUri: string; scope: string; expiresAt: number }>;
  tokens: Record<string, { clientId: string; scopes: string[]; expiresAt: number }>;
  refreshTokens: Record<string, { accessToken: string; clientId: string; scopes: string[]; createdAt: number }>;
};

function loadState(): PersistedState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PersistedState;
      console.log('Loaded OAuth state from disk', {
        clients: Object.keys(data.clients || {}).length,
        tokens: Object.keys(data.tokens || {}).length,
      });
      return {
        clients: data.clients || {},
        authCodes: data.authCodes || {},
        tokens: data.tokens || {},
        refreshTokens: data.refreshTokens || {},
      };
    }
  } catch (error) {
    console.error('Failed to load OAuth state', error);
  }
  return { clients: {}, authCodes: {}, tokens: {}, refreshTokens: {} };
}

const state = loadState();

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Failed to save OAuth state', error);
  }
}

// Allow pre-shared tokens via env (comma-separated)
const allowedTokens = new Set(
  (process.env.MCP_ALLOWED_TOKENS || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// OAuthServerProvider implementation using the MCP SDK
// ---------------------------------------------------------------------------
class ClickUpOAuthProvider implements OAuthServerProvider {
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        return state.clients[clientId];
      },
      registerClient(clientData: any): OAuthClientInformationFull {
        const clientId = `mcp-client-${randomUUID()}`;
        const client: OAuthClientInformationFull = {
          ...clientData,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        state.clients[clientId] = client;
        saveState();
        console.log('Registered client', { clientId });
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = randomUUID();
    state.authCodes[code] = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scope: params.scopes?.join(' ') || DEFAULT_SCOPE,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    saveState();
    console.log('Issued authorization code', { clientId: client.client_id, code });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = state.authCodes[authorizationCode];
    if (!record) {
      throw new Error('Unknown authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = state.authCodes[authorizationCode];
    if (!record) {
      throw new Error('Unknown authorization code');
    }
    if (record.clientId !== client.client_id) {
      throw new Error('Client mismatch');
    }
    if (Date.now() > record.expiresAt) {
      delete state.authCodes[authorizationCode];
      saveState();
      throw new Error('Authorization code expired');
    }

    delete state.authCodes[authorizationCode];

    const accessToken = `mcp_${randomUUID()}`;
    const refreshToken = `refresh_${randomUUID()}`;
    const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

    state.tokens[accessToken] = {
      clientId: client.client_id,
      scopes: record.scope.split(' '),
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
    state.refreshTokens[refreshToken] = {
      accessToken,
      clientId: client.client_id,
      scopes: record.scope.split(' '),
      createdAt: Date.now(),
    };
    saveState();

    console.log('Token exchange successful', { clientId: client.client_id });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: record.scope,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = state.refreshTokens[refreshToken];
    if (!record || record.clientId !== client.client_id) {
      throw new Error('Invalid refresh token');
    }

    // Revoke old access token
    delete state.tokens[record.accessToken];

    const accessToken = `mcp_${randomUUID()}`;
    const newRefreshToken = `refresh_${randomUUID()}`;
    const resolvedScopes = scopes || record.scopes;
    const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

    state.tokens[accessToken] = {
      clientId: client.client_id,
      scopes: resolvedScopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };

    // Rotate refresh token
    delete state.refreshTokens[refreshToken];
    state.refreshTokens[newRefreshToken] = {
      accessToken,
      clientId: client.client_id,
      scopes: resolvedScopes,
      createdAt: Date.now(),
    };
    saveState();

    console.log('Token refresh successful', { clientId: client.client_id });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: resolvedScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check pre-shared tokens first (never expire)
    if (allowedTokens.has(token)) {
      return {
        token,
        clientId: 'pre-shared',
        scopes: SCOPES.slice(),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    }

    const record = state.tokens[token];
    if (!record) {
      throw new Error('Invalid token');
    }
    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      delete state.tokens[token];
      saveState();
      throw new Error('Token expired');
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    delete state.tokens[request.token];
    delete state.refreshTokens[request.token];
    saveState();
  }
}

const oauthProvider = new ClickUpOAuthProvider();

class ClickUpMCPServer {
  private app: express.Application;
  private clickUpClient: ClickUpClient;
  private clickUpApiToken: string;
  private clickUpBaseUrl: string;
  private toolConfigs: ToolConfig[];

  constructor() {
    const CLICKUP_API_TOKEN = process.env.CLICKUP_ACCESS_TOKEN || process.env.CLICKUP_API_TOKEN;
    if (!CLICKUP_API_TOKEN) {
      console.error('Error: CLICKUP_ACCESS_TOKEN environment variable is required');
      process.exit(1);
    }
    this.clickUpApiToken = CLICKUP_API_TOKEN;
    this.clickUpBaseUrl = (process.env.CLICKUP_API_BASE_URL || 'https://api.clickup.com/api/v2').replace(/\/$/, '');
    this.clickUpClient = new ClickUpClient(this.clickUpApiToken, this.clickUpBaseUrl);

    this.app = express();
    this.toolConfigs = this.buildToolConfigs();
    this.setupExpress();
  }

  private createServer(): Server {
    const server = new Server(
      { name: 'clickup-mcp-server-http', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolConfigs.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      console.log(`tools/list: returning ${tools.length} tools`);
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const tool = this.toolConfigs.find(config => config.name === request.params.name);
        if (!tool) {
          throw new Error(`Unknown tool: ${request.params.name}`);
        }
        return await tool.handler(request.params.arguments ?? {});
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('MCP CallTool error', { tool: request.params.name, error: errorMessage });
        return buildToolResponse({ success: false, error: errorMessage }, true);
      }
    });
    return server;
  }

  private createTool(config: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: (args: Record<string, unknown>) => string;
    buildQuery?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
    buildBody?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
    transform?: (payload: any) => Record<string, unknown>;
  }): ToolConfig {
    return {
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      handler: async (rawArgs: unknown) => {
        const args = ensureObject<Record<string, unknown>>(rawArgs ?? {}, 'arguments');
        const query = config.buildQuery ? config.buildQuery(args) : undefined;
        const body = config.buildBody ? config.buildBody(args) : undefined;

        let payload: any;
        switch (config.method) {
          case 'GET':
            payload = await this.clickUpClient.get(config.path(args), query);
            break;
          case 'POST':
            payload = await this.clickUpClient.post(config.path(args), body, query);
            break;
          case 'PUT':
            payload = await this.clickUpClient.put(config.path(args), body, query);
            break;
          case 'DELETE':
            payload = await this.clickUpClient.delete(config.path(args), body, query);
            break;
          default:
            throw new Error(`Unsupported HTTP method: ${config.method}`);
        }

        const result = config.transform
          ? config.transform(payload)
          : { success: true, data: payload };

        return buildToolResponse(result, false);
      },
    };
  }

  private buildToolConfigs(): ToolConfig[] {
    // -----------------------------------------------------------------------
    // READ TOOLS
    // -----------------------------------------------------------------------
    const readTools: ToolConfig[] = [
      // --- Workspaces (ClickUp calls them "teams") ---
      this.createTool({
        name: 'clickup_get_workspaces',
        description: 'List all workspaces (teams) the authenticated user belongs to.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/team',
        transform: payload => ({ success: true, workspaces: payload?.teams ?? [] }),
      }),

      // --- Spaces ---
      this.createTool({
        name: 'clickup_get_spaces',
        description: 'List all spaces in a workspace (team).',
        inputSchema: {
          type: 'object',
          required: ['team_id'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
            archived: { type: 'boolean', description: 'Include archived spaces.' },
          },
        },
        method: 'GET',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}/space`,
        buildQuery: args => ({
          archived: ensureOptionalBoolean(args.archived, 'archived'),
        }),
        transform: payload => ({ success: true, spaces: payload?.spaces ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_space',
        description: 'Get a single space by ID.',
        inputSchema: {
          type: 'object',
          required: ['space_id'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}`,
        transform: payload => ({ success: true, space: payload }),
      }),

      // --- Folders ---
      this.createTool({
        name: 'clickup_get_folders',
        description: 'List all folders in a space.',
        inputSchema: {
          type: 'object',
          required: ['space_id'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
            archived: { type: 'boolean', description: 'Include archived folders.' },
          },
        },
        method: 'GET',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/folder`,
        buildQuery: args => ({
          archived: ensureOptionalBoolean(args.archived, 'archived'),
        }),
        transform: payload => ({ success: true, folders: payload?.folders ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_folder',
        description: 'Get a single folder by ID.',
        inputSchema: {
          type: 'object',
          required: ['folder_id'],
          additionalProperties: false,
          properties: {
            folder_id: idSchema('Folder ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/folder/${ensureId(args.folder_id, 'folder_id')}`,
        transform: payload => ({ success: true, folder: payload }),
      }),

      // --- Lists ---
      this.createTool({
        name: 'clickup_get_lists',
        description: 'List all lists in a folder.',
        inputSchema: {
          type: 'object',
          required: ['folder_id'],
          additionalProperties: false,
          properties: {
            folder_id: idSchema('Folder ID.'),
            archived: { type: 'boolean', description: 'Include archived lists.' },
          },
        },
        method: 'GET',
        path: args => `/folder/${ensureId(args.folder_id, 'folder_id')}/list`,
        buildQuery: args => ({
          archived: ensureOptionalBoolean(args.archived, 'archived'),
        }),
        transform: payload => ({ success: true, lists: payload?.lists ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_folderless_lists',
        description: 'List all folderless lists in a space.',
        inputSchema: {
          type: 'object',
          required: ['space_id'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
            archived: { type: 'boolean', description: 'Include archived lists.' },
          },
        },
        method: 'GET',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/list`,
        buildQuery: args => ({
          archived: ensureOptionalBoolean(args.archived, 'archived'),
        }),
        transform: payload => ({ success: true, lists: payload?.lists ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_list',
        description: 'Get a single list by ID.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}`,
        transform: payload => ({ success: true, list: payload }),
      }),

      // --- Tasks ---
      this.createTool({
        name: 'clickup_get_task',
        description: 'Get a single task by ID. Supports custom_task_ids with team_id.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to retrieve.'),
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID. Required when custom_task_ids is true.'),
            include_subtasks: { type: 'boolean', description: 'Include subtasks in the response.' },
            include_markdown_description: { type: 'boolean', description: 'Include markdown description.' },
          },
        },
        method: 'GET',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
          include_subtasks: ensureOptionalBoolean(args.include_subtasks, 'include_subtasks'),
          include_markdown_description: ensureOptionalBoolean(args.include_markdown_description, 'include_markdown_description'),
        }),
        transform: payload => ({ success: true, task: payload }),
      }),

      this.createTool({
        name: 'clickup_get_tasks',
        description: 'List tasks in a list. Supports filtering by assignees, statuses, dates, and pagination.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID.'),
            archived: { type: 'boolean', description: 'Include archived tasks.' },
            include_markdown_description: { type: 'boolean', description: 'Include markdown description.' },
            page: { type: 'integer', minimum: 0, description: 'Page number (0-indexed).' },
            order_by: { type: 'string', description: 'Order by field: id, created, updated, due_date.' },
            reverse: { type: 'boolean', description: 'Reverse the order.' },
            subtasks: { type: 'boolean', description: 'Include subtasks.' },
            statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by status names.' },
            include_closed: { type: 'boolean', description: 'Include closed tasks.' },
            assignees: { type: 'array', items: { type: 'string' }, description: 'Filter by assignee IDs.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag names.' },
            due_date_gt: { type: 'number', description: 'Filter tasks with due date greater than (Unix ms).' },
            due_date_lt: { type: 'number', description: 'Filter tasks with due date less than (Unix ms).' },
            date_created_gt: { type: 'number', description: 'Filter tasks created after (Unix ms).' },
            date_created_lt: { type: 'number', description: 'Filter tasks created before (Unix ms).' },
            date_updated_gt: { type: 'number', description: 'Filter tasks updated after (Unix ms).' },
            date_updated_lt: { type: 'number', description: 'Filter tasks updated before (Unix ms).' },
            date_done_gt: { type: 'number', description: 'Filter tasks done after (Unix ms).' },
            date_done_lt: { type: 'number', description: 'Filter tasks done before (Unix ms).' },
            custom_fields: { type: 'array', description: 'Custom field filter objects.' },
          },
        },
        method: 'GET',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/task`,
        buildQuery: args => ({
          archived: ensureOptionalBoolean(args.archived, 'archived'),
          include_markdown_description: ensureOptionalBoolean(args.include_markdown_description, 'include_markdown_description'),
          page: ensureOptionalNumber(args.page, 'page'),
          order_by: ensureOptionalString(args.order_by, 'order_by'),
          reverse: ensureOptionalBoolean(args.reverse, 'reverse'),
          subtasks: ensureOptionalBoolean(args.subtasks, 'subtasks'),
          statuses: ensureStringArray(args.statuses, 'statuses'),
          include_closed: ensureOptionalBoolean(args.include_closed, 'include_closed'),
          assignees: ensureStringArray(args.assignees, 'assignees'),
          tags: ensureStringArray(args.tags, 'tags'),
          due_date_gt: ensureOptionalNumber(args.due_date_gt, 'due_date_gt'),
          due_date_lt: ensureOptionalNumber(args.due_date_lt, 'due_date_lt'),
          date_created_gt: ensureOptionalNumber(args.date_created_gt, 'date_created_gt'),
          date_created_lt: ensureOptionalNumber(args.date_created_lt, 'date_created_lt'),
          date_updated_gt: ensureOptionalNumber(args.date_updated_gt, 'date_updated_gt'),
          date_updated_lt: ensureOptionalNumber(args.date_updated_lt, 'date_updated_lt'),
          date_done_gt: ensureOptionalNumber(args.date_done_gt, 'date_done_gt'),
          date_done_lt: ensureOptionalNumber(args.date_done_lt, 'date_done_lt'),
          custom_fields: args.custom_fields ? JSON.stringify(args.custom_fields) : undefined,
        }),
        transform: payload => ({ success: true, tasks: payload?.tasks ?? [] }),
      }),

      // --- Members ---
      this.createTool({
        name: 'clickup_get_list_members',
        description: 'List members of a list.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID.'),
          },
        },
        method: 'GET',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/member`,
        transform: payload => ({ success: true, members: payload?.members ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_workspace_members',
        description: 'List members of a workspace (team).',
        inputSchema: {
          type: 'object',
          required: ['team_id'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
          },
        },
        method: 'GET',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}`,
        transform: payload => ({ success: true, members: payload?.team?.members ?? payload?.members ?? [] }),
      }),

      // --- Comments ---
      this.createTool({
        name: 'clickup_get_task_comments',
        description: 'List comments on a task.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID.'),
            start: { type: 'number', description: 'Start timestamp for pagination (Unix ms).' },
            start_id: { type: 'string', description: 'Start comment ID for pagination.' },
          },
        },
        method: 'GET',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/comment`,
        buildQuery: args => ({
          start: ensureOptionalNumber(args.start, 'start'),
          start_id: ensureOptionalString(args.start_id, 'start_id'),
        }),
        transform: payload => ({ success: true, comments: payload?.comments ?? [] }),
      }),

      // --- Custom Fields ---
      this.createTool({
        name: 'clickup_get_custom_fields',
        description: 'List custom fields available on a list.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID.'),
          },
        },
        method: 'GET',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/field`,
        transform: payload => ({ success: true, fields: payload?.fields ?? [] }),
      }),

      // --- Tags ---
      this.createTool({
        name: 'clickup_get_tags',
        description: 'List tags in a space.',
        inputSchema: {
          type: 'object',
          required: ['space_id'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
          },
        },
        method: 'GET',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/tag`,
        transform: payload => ({ success: true, tags: payload?.tags ?? [] }),
      }),

      // --- Goals ---
      this.createTool({
        name: 'clickup_get_goals',
        description: 'List goals in a workspace.',
        inputSchema: {
          type: 'object',
          required: ['team_id'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
            include_completed: { type: 'boolean', description: 'Include completed goals.' },
          },
        },
        method: 'GET',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}/goal`,
        buildQuery: args => ({
          include_completed: ensureOptionalBoolean(args.include_completed, 'include_completed'),
        }),
        transform: payload => ({ success: true, goals: payload?.goals ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_goal',
        description: 'Get a single goal by ID.',
        inputSchema: {
          type: 'object',
          required: ['goal_id'],
          additionalProperties: false,
          properties: {
            goal_id: idSchema('Goal ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/goal/${ensureId(args.goal_id, 'goal_id')}`,
        transform: payload => ({ success: true, goal: payload?.goal ?? payload }),
      }),

      // --- Search Tasks ---
      this.createTool({
        name: 'clickup_search_tasks',
        description: 'Search and filter tasks across an entire workspace. Supports filtering by assignees, statuses, tags, due dates, and more.',
        inputSchema: {
          type: 'object',
          required: ['team_id'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
            page: { type: 'integer', minimum: 0, description: 'Page number (0-indexed).' },
            order_by: { type: 'string', description: 'Order by: id, created, updated, due_date.' },
            reverse: { type: 'boolean', description: 'Reverse sort order.' },
            subtasks: { type: 'boolean', description: 'Include subtasks.' },
            statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by status names.' },
            include_closed: { type: 'boolean', description: 'Include closed tasks.' },
            assignees: { type: 'array', items: { type: 'string' }, description: 'Filter by assignee IDs.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag names.' },
            due_date_gt: { type: 'number', description: 'Due date greater than (Unix ms).' },
            due_date_lt: { type: 'number', description: 'Due date less than (Unix ms).' },
            date_created_gt: { type: 'number', description: 'Created after (Unix ms).' },
            date_created_lt: { type: 'number', description: 'Created before (Unix ms).' },
            date_updated_gt: { type: 'number', description: 'Updated after (Unix ms).' },
            date_updated_lt: { type: 'number', description: 'Updated before (Unix ms).' },
            date_done_gt: { type: 'number', description: 'Done after (Unix ms).' },
            date_done_lt: { type: 'number', description: 'Done before (Unix ms).' },
            custom_fields: { type: 'array', description: 'Custom field filter objects.' },
            list_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by list IDs.' },
            space_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by space IDs.' },
            folder_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by folder IDs.' },
            project_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by project IDs.' },
            include_markdown_description: { type: 'boolean', description: 'Include markdown description.' },
          },
        },
        method: 'GET',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}/task`,
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
          order_by: ensureOptionalString(args.order_by, 'order_by'),
          reverse: ensureOptionalBoolean(args.reverse, 'reverse'),
          subtasks: ensureOptionalBoolean(args.subtasks, 'subtasks'),
          statuses: ensureStringArray(args.statuses, 'statuses'),
          include_closed: ensureOptionalBoolean(args.include_closed, 'include_closed'),
          assignees: ensureStringArray(args.assignees, 'assignees'),
          tags: ensureStringArray(args.tags, 'tags'),
          due_date_gt: ensureOptionalNumber(args.due_date_gt, 'due_date_gt'),
          due_date_lt: ensureOptionalNumber(args.due_date_lt, 'due_date_lt'),
          date_created_gt: ensureOptionalNumber(args.date_created_gt, 'date_created_gt'),
          date_created_lt: ensureOptionalNumber(args.date_created_lt, 'date_created_lt'),
          date_updated_gt: ensureOptionalNumber(args.date_updated_gt, 'date_updated_gt'),
          date_updated_lt: ensureOptionalNumber(args.date_updated_lt, 'date_updated_lt'),
          date_done_gt: ensureOptionalNumber(args.date_done_gt, 'date_done_gt'),
          date_done_lt: ensureOptionalNumber(args.date_done_lt, 'date_done_lt'),
          custom_fields: args.custom_fields ? JSON.stringify(args.custom_fields) : undefined,
          list_ids: ensureStringArray(args.list_ids, 'list_ids'),
          space_ids: ensureStringArray(args.space_ids, 'space_ids'),
          folder_ids: ensureStringArray(args.folder_ids, 'folder_ids'),
          project_ids: ensureStringArray(args.project_ids, 'project_ids'),
          include_markdown_description: ensureOptionalBoolean(args.include_markdown_description, 'include_markdown_description'),
        }),
        transform: payload => ({ success: true, tasks: payload?.tasks ?? [] }),
      }),

      // --- Views ---
      this.createTool({
        name: 'clickup_get_list_views',
        description: 'List views for a list.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID.'),
          },
        },
        method: 'GET',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/view`,
        transform: payload => ({ success: true, views: payload?.views ?? [] }),
      }),

      this.createTool({
        name: 'clickup_get_view',
        description: 'Get a single view by ID.',
        inputSchema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: {
            view_id: idSchema('View ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/view/${ensureId(args.view_id, 'view_id')}`,
        transform: payload => ({ success: true, view: payload?.view ?? payload }),
      }),

      this.createTool({
        name: 'clickup_get_view_tasks',
        description: 'Get tasks from a view.',
        inputSchema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: {
            view_id: idSchema('View ID.'),
            page: { type: 'integer', minimum: 0, description: 'Page number (0-indexed).' },
          },
        },
        method: 'GET',
        path: args => `/view/${ensureId(args.view_id, 'view_id')}/task`,
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
        }),
        transform: payload => ({ success: true, tasks: payload?.tasks ?? [] }),
      }),
    ];

    // -----------------------------------------------------------------------
    // WRITE TOOLS
    // -----------------------------------------------------------------------
    const writeTools: ToolConfig[] = [
      // --- Create Space ---
      this.createTool({
        name: 'clickup_create_space',
        description: 'Create a new space in a workspace.',
        inputSchema: {
          type: 'object',
          required: ['team_id', 'name'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
            name: { type: 'string', description: 'Name of the new space.' },
            multiple_assignees: { type: 'boolean', description: 'Allow multiple assignees.' },
            features: { type: 'object', description: 'Space features configuration object.' },
          },
        },
        method: 'POST',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}/space`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const multipleAssignees = ensureOptionalBoolean(args.multiple_assignees, 'multiple_assignees');
          if (multipleAssignees !== undefined) body.multiple_assignees = multipleAssignees;
          if (args.features !== undefined) body.features = args.features;
          return body;
        },
        transform: payload => ({ success: true, space: payload }),
      }),

      // --- Create Folder ---
      this.createTool({
        name: 'clickup_create_folder',
        description: 'Create a new folder in a space.',
        inputSchema: {
          type: 'object',
          required: ['space_id', 'name'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
            name: { type: 'string', description: 'Name of the new folder.' },
          },
        },
        method: 'POST',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/folder`,
        buildBody: args => ({
          name: ensureString(args.name, 'name'),
        }),
        transform: payload => ({ success: true, folder: payload }),
      }),

      // --- Update Folder ---
      this.createTool({
        name: 'clickup_update_folder',
        description: 'Update a folder.',
        inputSchema: {
          type: 'object',
          required: ['folder_id', 'name'],
          additionalProperties: false,
          properties: {
            folder_id: idSchema('Folder ID to update.'),
            name: { type: 'string', description: 'New name for the folder.' },
          },
        },
        method: 'PUT',
        path: args => `/folder/${ensureId(args.folder_id, 'folder_id')}`,
        buildBody: args => ({
          name: ensureString(args.name, 'name'),
        }),
        transform: payload => ({ success: true, folder: payload }),
      }),

      // --- Delete Folder ---
      this.createTool({
        name: 'clickup_delete_folder',
        description: 'Delete a folder.',
        inputSchema: {
          type: 'object',
          required: ['folder_id'],
          additionalProperties: false,
          properties: {
            folder_id: idSchema('Folder ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/folder/${ensureId(args.folder_id, 'folder_id')}`,
        transform: () => ({ success: true }),
      }),

      // --- Create List (in folder) ---
      this.createTool({
        name: 'clickup_create_list',
        description: 'Create a new list in a folder.',
        inputSchema: {
          type: 'object',
          required: ['folder_id', 'name'],
          additionalProperties: false,
          properties: {
            folder_id: idSchema('Folder ID.'),
            name: { type: 'string', description: 'Name of the new list.' },
            content: { type: 'string', description: 'Description/content of the list.' },
            due_date: { type: 'number', description: 'Due date as Unix timestamp in milliseconds.' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes a time component.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            assignee: idSchema('Assignee user ID.'),
            status: { type: 'string', description: 'Status name to set.' },
          },
        },
        method: 'POST',
        path: args => `/folder/${ensureId(args.folder_id, 'folder_id')}/list`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const content = ensureOptionalString(args.content, 'content');
          if (content) body.content = content;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const assignee = ensureOptionalId(args.assignee, 'assignee');
          if (assignee) body.assignee = parseInt(assignee, 10) || assignee;
          const status = ensureOptionalString(args.status, 'status');
          if (status) body.status = status;
          return body;
        },
        transform: payload => ({ success: true, list: payload }),
      }),

      // --- Create Folderless List ---
      this.createTool({
        name: 'clickup_create_folderless_list',
        description: 'Create a new list directly in a space (no folder).',
        inputSchema: {
          type: 'object',
          required: ['space_id', 'name'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
            name: { type: 'string', description: 'Name of the new list.' },
            content: { type: 'string', description: 'Description/content of the list.' },
            due_date: { type: 'number', description: 'Due date as Unix timestamp in milliseconds.' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes a time component.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            assignee: idSchema('Assignee user ID.'),
            status: { type: 'string', description: 'Status name to set.' },
          },
        },
        method: 'POST',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/list`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const content = ensureOptionalString(args.content, 'content');
          if (content) body.content = content;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const assignee = ensureOptionalId(args.assignee, 'assignee');
          if (assignee) body.assignee = parseInt(assignee, 10) || assignee;
          const status = ensureOptionalString(args.status, 'status');
          if (status) body.status = status;
          return body;
        },
        transform: payload => ({ success: true, list: payload }),
      }),

      // --- Update List ---
      this.createTool({
        name: 'clickup_update_list',
        description: 'Update a list.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID to update.'),
            name: { type: 'string', description: 'New name for the list.' },
            content: { type: 'string', description: 'New description/content.' },
            due_date: { type: 'number', description: 'Due date as Unix timestamp in milliseconds.' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes a time component.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            assignee: idSchema('Assignee user ID.'),
            unset_status: { type: 'boolean', description: 'Remove the list status.' },
          },
        },
        method: 'PUT',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}`,
        buildBody: args => {
          const body: Record<string, unknown> = {};
          const name = ensureOptionalString(args.name, 'name');
          if (name) body.name = name;
          const content = ensureOptionalString(args.content, 'content');
          if (content) body.content = content;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const assignee = ensureOptionalId(args.assignee, 'assignee');
          if (assignee) body.assignee = parseInt(assignee, 10) || assignee;
          const unsetStatus = ensureOptionalBoolean(args.unset_status, 'unset_status');
          if (unsetStatus !== undefined) body.unset_status = unsetStatus;
          return body;
        },
        transform: payload => ({ success: true, list: payload }),
      }),

      // --- Delete List ---
      this.createTool({
        name: 'clickup_delete_list',
        description: 'Delete a list.',
        inputSchema: {
          type: 'object',
          required: ['list_id'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}`,
        transform: () => ({ success: true }),
      }),

      // --- Create Task ---
      this.createTool({
        name: 'clickup_create_task',
        description: 'Create a new task in a list. Supports name, description, assignees, tags, status, priority, due dates, custom fields, and more.',
        inputSchema: {
          type: 'object',
          required: ['list_id', 'name'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID to create the task in.'),
            name: { type: 'string', description: 'Task name.' },
            description: { type: 'string', description: 'Plain text description.' },
            markdown_description: { type: 'string', description: 'Markdown description (takes precedence over description).' },
            assignees: { type: 'array', items: { type: 'integer' }, description: 'Array of assignee user IDs (integers).' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Array of tag names.' },
            status: { type: 'string', description: 'Status name to set.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            due_date: { type: 'number', description: 'Due date as Unix timestamp in milliseconds.' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes time.' },
            start_date: { type: 'number', description: 'Start date as Unix timestamp in milliseconds.' },
            start_date_time: { type: 'boolean', description: 'Whether start_date includes time.' },
            time_estimate: { type: 'number', description: 'Time estimate in milliseconds.' },
            parent: idSchema('Parent task ID to create this as a subtask.'),
            links_to: idSchema('Task ID to link to.'),
            notify_all: { type: 'boolean', description: 'Notify all assignees.' },
            custom_fields: {
              type: 'array',
              description: 'Array of custom field objects: [{ "id": "field_id", "value": ... }].',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  value: {},
                },
              },
            },
            check_required_custom_fields: { type: 'boolean', description: 'Validate required custom fields.' },
          },
        },
        method: 'POST',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/task`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const description = ensureOptionalString(args.description, 'description');
          if (description) body.description = description;
          const markdownDescription = ensureOptionalString(args.markdown_description, 'markdown_description');
          if (markdownDescription) body.markdown_description = markdownDescription;
          if (Array.isArray(args.assignees)) body.assignees = args.assignees;
          if (Array.isArray(args.tags)) body.tags = args.tags;
          const status = ensureOptionalString(args.status, 'status');
          if (status) body.status = status;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const startDate = ensureOptionalNumber(args.start_date, 'start_date');
          if (startDate !== undefined) body.start_date = startDate;
          const startDateTime = ensureOptionalBoolean(args.start_date_time, 'start_date_time');
          if (startDateTime !== undefined) body.start_date_time = startDateTime;
          const timeEstimate = ensureOptionalNumber(args.time_estimate, 'time_estimate');
          if (timeEstimate !== undefined) body.time_estimate = timeEstimate;
          const parent = ensureOptionalId(args.parent, 'parent');
          if (parent) body.parent = parent;
          const linksTo = ensureOptionalId(args.links_to, 'links_to');
          if (linksTo) body.links_to = linksTo;
          const notifyAll = ensureOptionalBoolean(args.notify_all, 'notify_all');
          if (notifyAll !== undefined) body.notify_all = notifyAll;
          if (Array.isArray(args.custom_fields)) body.custom_fields = args.custom_fields;
          const checkRequired = ensureOptionalBoolean(args.check_required_custom_fields, 'check_required_custom_fields');
          if (checkRequired !== undefined) body.check_required_custom_fields = checkRequired;
          return body;
        },
        transform: payload => ({ success: true, task: payload }),
      }),

      // --- Create Subtask (convenience wrapper) ---
      this.createTool({
        name: 'clickup_create_subtask',
        description: 'Create a subtask under a parent task. This is a convenience wrapper that creates a task with the parent field set.',
        inputSchema: {
          type: 'object',
          required: ['list_id', 'parent', 'name'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('List ID to create the subtask in.'),
            parent: idSchema('Parent task ID.'),
            name: { type: 'string', description: 'Subtask name.' },
            description: { type: 'string', description: 'Plain text description.' },
            markdown_description: { type: 'string', description: 'Markdown description.' },
            assignees: { type: 'array', items: { type: 'integer' }, description: 'Array of assignee user IDs.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Array of tag names.' },
            status: { type: 'string', description: 'Status name.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            due_date: { type: 'number', description: 'Due date (Unix ms).' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes time.' },
            start_date: { type: 'number', description: 'Start date (Unix ms).' },
            start_date_time: { type: 'boolean', description: 'Whether start_date includes time.' },
            notify_all: { type: 'boolean', description: 'Notify all assignees.' },
            custom_fields: {
              type: 'array',
              description: 'Array of custom field objects.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  value: {},
                },
              },
            },
          },
        },
        method: 'POST',
        path: args => `/list/${ensureId(args.list_id, 'list_id')}/task`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
            parent: ensureId(args.parent, 'parent'),
          };
          const description = ensureOptionalString(args.description, 'description');
          if (description) body.description = description;
          const markdownDescription = ensureOptionalString(args.markdown_description, 'markdown_description');
          if (markdownDescription) body.markdown_description = markdownDescription;
          if (Array.isArray(args.assignees)) body.assignees = args.assignees;
          if (Array.isArray(args.tags)) body.tags = args.tags;
          const status = ensureOptionalString(args.status, 'status');
          if (status) body.status = status;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const startDate = ensureOptionalNumber(args.start_date, 'start_date');
          if (startDate !== undefined) body.start_date = startDate;
          const startDateTime = ensureOptionalBoolean(args.start_date_time, 'start_date_time');
          if (startDateTime !== undefined) body.start_date_time = startDateTime;
          const notifyAll = ensureOptionalBoolean(args.notify_all, 'notify_all');
          if (notifyAll !== undefined) body.notify_all = notifyAll;
          if (Array.isArray(args.custom_fields)) body.custom_fields = args.custom_fields;
          return body;
        },
        transform: payload => ({ success: true, task: payload }),
      }),

      // --- Update Task ---
      this.createTool({
        name: 'clickup_update_task',
        description: 'Update an existing task. Any fields not provided will remain unchanged.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to update.'),
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID. Required when custom_task_ids is true.'),
            name: { type: 'string', description: 'New task name.' },
            description: { type: 'string', description: 'New plain text description.' },
            markdown_description: { type: 'string', description: 'New markdown description.' },
            assignees: {
              type: 'object',
              description: 'Assignee changes: { "add": [user_ids], "rem": [user_ids] }.',
              properties: {
                add: { type: 'array', items: { type: 'integer' } },
                rem: { type: 'array', items: { type: 'integer' } },
              },
            },
            status: { type: 'string', description: 'New status name.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low.' },
            due_date: { type: 'number', description: 'Due date (Unix ms).' },
            due_date_time: { type: 'boolean', description: 'Whether due_date includes time.' },
            start_date: { type: 'number', description: 'Start date (Unix ms).' },
            start_date_time: { type: 'boolean', description: 'Whether start_date includes time.' },
            time_estimate: { type: 'number', description: 'Time estimate in milliseconds.' },
            parent: idSchema('New parent task ID (move to subtask).'),
            archived: { type: 'boolean', description: 'Archive or unarchive the task.' },
          },
        },
        method: 'PUT',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        buildBody: args => {
          const body: Record<string, unknown> = {};
          const name = ensureOptionalString(args.name, 'name');
          if (name) body.name = name;
          const description = ensureOptionalString(args.description, 'description');
          if (description) body.description = description;
          const markdownDescription = ensureOptionalString(args.markdown_description, 'markdown_description');
          if (markdownDescription) body.markdown_description = markdownDescription;
          if (args.assignees !== undefined) body.assignees = args.assignees;
          const status = ensureOptionalString(args.status, 'status');
          if (status) body.status = status;
          const priority = ensureOptionalIntegerInRange(args.priority, 'priority', 1, 4);
          if (priority !== undefined) body.priority = priority;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const dueDateTime = ensureOptionalBoolean(args.due_date_time, 'due_date_time');
          if (dueDateTime !== undefined) body.due_date_time = dueDateTime;
          const startDate = ensureOptionalNumber(args.start_date, 'start_date');
          if (startDate !== undefined) body.start_date = startDate;
          const startDateTime = ensureOptionalBoolean(args.start_date_time, 'start_date_time');
          if (startDateTime !== undefined) body.start_date_time = startDateTime;
          const timeEstimate = ensureOptionalNumber(args.time_estimate, 'time_estimate');
          if (timeEstimate !== undefined) body.time_estimate = timeEstimate;
          const parent = ensureOptionalId(args.parent, 'parent');
          if (parent) body.parent = parent;
          const archived = ensureOptionalBoolean(args.archived, 'archived');
          if (archived !== undefined) body.archived = archived;
          return body;
        },
        transform: payload => ({ success: true, task: payload }),
      }),

      // --- Delete Task ---
      this.createTool({
        name: 'clickup_delete_task',
        description: 'Delete a task.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to delete.'),
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID. Required when custom_task_ids is true.'),
          },
        },
        method: 'DELETE',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        transform: () => ({ success: true }),
      }),

      // --- Add Comment ---
      this.createTool({
        name: 'clickup_add_comment',
        description: 'Add a comment to a task.',
        inputSchema: {
          type: 'object',
          required: ['task_id', 'comment_text'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID.'),
            comment_text: { type: 'string', description: 'The comment text.' },
            assignee: { type: 'integer', description: 'User ID to assign the comment to.' },
            notify_all: { type: 'boolean', description: 'Notify all assignees.' },
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID. Required when custom_task_ids is true.'),
          },
        },
        method: 'POST',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/comment`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        buildBody: args => {
          const body: Record<string, unknown> = {
            comment_text: ensureString(args.comment_text, 'comment_text'),
          };
          if (args.assignee !== undefined) body.assignee = args.assignee;
          const notifyAll = ensureOptionalBoolean(args.notify_all, 'notify_all');
          if (notifyAll !== undefined) body.notify_all = notifyAll;
          return body;
        },
        transform: payload => ({ success: true, comment: payload }),
      }),

      // --- Add Dependency ---
      this.createTool({
        name: 'clickup_add_dependency',
        description: 'Add a dependency between two tasks. Use depends_on to specify that the given task depends on another, or dependency_of to specify that another task depends on this one.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to add the dependency to.'),
            depends_on: idSchema('Task ID that this task depends on (is blocked by).'),
            dependency_of: idSchema('Task ID that depends on this task (is blocking).'),
            custom_task_ids: { type: 'boolean', description: 'Set to true if using custom task IDs.' },
            team_id: idSchema('Workspace (team) ID. Required when custom_task_ids is true.'),
          },
        },
        method: 'POST',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/dependency`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        buildBody: args => {
          const body: Record<string, unknown> = {};
          const dependsOn = ensureOptionalId(args.depends_on, 'depends_on');
          const dependencyOf = ensureOptionalId(args.dependency_of, 'dependency_of');
          if (!dependsOn && !dependencyOf) {
            throw new Error('Provide either depends_on or dependency_of');
          }
          if (dependsOn && dependencyOf) {
            throw new Error('Provide only one of depends_on or dependency_of');
          }
          if (dependsOn) body.depends_on = dependsOn;
          if (dependencyOf) body.dependency_of = dependencyOf;
          return body;
        },
        transform: payload => ({ success: true, dependency: payload }),
      }),

      // --- Delete Dependency ---
      this.createTool({
        name: 'clickup_delete_dependency',
        description: 'Remove a dependency between tasks.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to remove the dependency from.'),
            depends_on: idSchema('Task ID that this task depends on.'),
            dependency_of: idSchema('Task ID that depends on this task.'),
            custom_task_ids: { type: 'boolean', description: 'Set to true if using custom task IDs.' },
            team_id: idSchema('Workspace (team) ID.'),
          },
        },
        method: 'DELETE',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/dependency`,
        buildQuery: args => {
          const dependsOn = ensureOptionalId(args.depends_on, 'depends_on');
          const dependencyOf = ensureOptionalId(args.dependency_of, 'dependency_of');
          if (!dependsOn && !dependencyOf) {
            throw new Error('Provide either depends_on or dependency_of');
          }
          return {
            depends_on: dependsOn,
            dependency_of: dependencyOf,
            custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
            team_id: ensureOptionalId(args.team_id, 'team_id'),
          };
        },
        transform: () => ({ success: true }),
      }),

      // --- Add Tag to Task ---
      this.createTool({
        name: 'clickup_add_tag_to_task',
        description: 'Add a tag to a task.',
        inputSchema: {
          type: 'object',
          required: ['task_id', 'tag_name'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID.'),
            tag_name: { type: 'string', description: 'Tag name to add.' },
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID.'),
          },
        },
        method: 'POST',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/tag/${encodeURIComponent(ensureString(args.tag_name, 'tag_name'))}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        transform: () => ({ success: true }),
      }),

      // --- Remove Tag from Task ---
      this.createTool({
        name: 'clickup_remove_tag_from_task',
        description: 'Remove a tag from a task.',
        inputSchema: {
          type: 'object',
          required: ['task_id', 'tag_name'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID.'),
            tag_name: { type: 'string', description: 'Tag name to remove.' },
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID.'),
          },
        },
        method: 'DELETE',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/tag/${encodeURIComponent(ensureString(args.tag_name, 'tag_name'))}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        transform: () => ({ success: true }),
      }),

      // --- Set Custom Field Value ---
      this.createTool({
        name: 'clickup_set_custom_field_value',
        description: 'Set a custom field value on a task. The value format depends on the field type.',
        inputSchema: {
          type: 'object',
          required: ['task_id', 'field_id', 'value'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID.'),
            field_id: idSchema('Custom field ID.'),
            value: { description: 'The value to set. Format depends on field type (string, number, array, object, etc.).' },
            custom_task_ids: { type: 'boolean', description: 'Set to true if using a custom task ID.' },
            team_id: idSchema('Workspace (team) ID.'),
          },
        },
        method: 'POST',
        path: args => `/task/${ensureId(args.task_id, 'task_id')}/field/${ensureId(args.field_id, 'field_id')}`,
        buildQuery: args => ({
          custom_task_ids: ensureOptionalBoolean(args.custom_task_ids, 'custom_task_ids'),
          team_id: ensureOptionalId(args.team_id, 'team_id'),
        }),
        buildBody: args => ({
          value: args.value,
        }),
        transform: () => ({ success: true }),
      }),

      // --- Create Goal ---
      this.createTool({
        name: 'clickup_create_goal',
        description: 'Create a new goal in a workspace.',
        inputSchema: {
          type: 'object',
          required: ['team_id', 'name'],
          additionalProperties: false,
          properties: {
            team_id: idSchema('Workspace (team) ID.'),
            name: { type: 'string', description: 'Goal name.' },
            due_date: { type: 'number', description: 'Due date (Unix ms).' },
            description: { type: 'string', description: 'Goal description.' },
            multiple_owners: { type: 'boolean', description: 'Allow multiple owners.' },
            owners: { type: 'array', items: { type: 'integer' }, description: 'Array of owner user IDs.' },
            color: { type: 'string', description: 'Goal color hex code.' },
          },
        },
        method: 'POST',
        path: args => `/team/${ensureId(args.team_id, 'team_id')}/goal`,
        buildBody: args => {
          const body: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const description = ensureOptionalString(args.description, 'description');
          if (description) body.description = description;
          const multipleOwners = ensureOptionalBoolean(args.multiple_owners, 'multiple_owners');
          if (multipleOwners !== undefined) body.multiple_owners = multipleOwners;
          if (Array.isArray(args.owners)) body.owners = args.owners;
          const color = ensureOptionalString(args.color, 'color');
          if (color) body.color = color;
          return body;
        },
        transform: payload => ({ success: true, goal: payload?.goal ?? payload }),
      }),

      // --- Update Goal ---
      this.createTool({
        name: 'clickup_update_goal',
        description: 'Update a goal.',
        inputSchema: {
          type: 'object',
          required: ['goal_id'],
          additionalProperties: false,
          properties: {
            goal_id: idSchema('Goal ID to update.'),
            name: { type: 'string', description: 'New goal name.' },
            due_date: { type: 'number', description: 'New due date (Unix ms).' },
            description: { type: 'string', description: 'New description.' },
            rem_owners: { type: 'array', items: { type: 'integer' }, description: 'User IDs to remove as owners.' },
            add_owners: { type: 'array', items: { type: 'integer' }, description: 'User IDs to add as owners.' },
            color: { type: 'string', description: 'New color hex code.' },
          },
        },
        method: 'PUT',
        path: args => `/goal/${ensureId(args.goal_id, 'goal_id')}`,
        buildBody: args => {
          const body: Record<string, unknown> = {};
          const name = ensureOptionalString(args.name, 'name');
          if (name) body.name = name;
          const dueDate = ensureOptionalNumber(args.due_date, 'due_date');
          if (dueDate !== undefined) body.due_date = dueDate;
          const description = ensureOptionalString(args.description, 'description');
          if (description) body.description = description;
          if (Array.isArray(args.rem_owners)) body.rem_owners = args.rem_owners;
          if (Array.isArray(args.add_owners)) body.add_owners = args.add_owners;
          const color = ensureOptionalString(args.color, 'color');
          if (color) body.color = color;
          return body;
        },
        transform: payload => ({ success: true, goal: payload?.goal ?? payload }),
      }),

      // --- Create Space Tag ---
      this.createTool({
        name: 'clickup_create_space_tag',
        description: 'Create a tag in a space.',
        inputSchema: {
          type: 'object',
          required: ['space_id', 'name'],
          additionalProperties: false,
          properties: {
            space_id: idSchema('Space ID.'),
            name: { type: 'string', description: 'Tag name.' },
            tag_fg: { type: 'string', description: 'Foreground color hex.' },
            tag_bg: { type: 'string', description: 'Background color hex.' },
          },
        },
        method: 'POST',
        path: args => `/space/${ensureId(args.space_id, 'space_id')}/tag`,
        buildBody: args => {
          const tag: Record<string, unknown> = {
            name: ensureString(args.name, 'name'),
          };
          const tagFg = ensureOptionalString(args.tag_fg, 'tag_fg');
          if (tagFg) tag.tag_fg = tagFg;
          const tagBg = ensureOptionalString(args.tag_bg, 'tag_bg');
          if (tagBg) tag.tag_bg = tagBg;
          return { tag };
        },
        transform: () => ({ success: true }),
      }),
    ];

    return [...readTools, ...writeTools];
  }

  private setupExpress() {
    this.app.set('trust proxy', 1);
    this.app.use(cors({
      origin: '*',
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['content-type', 'authorization', 'mcp-session-id'],
    }));

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));

    // Log all incoming requests for debugging
    this.app.use((req, res, next) => {
      if (req.path !== '/health') {
        console.log(`[REQ] ${req.method} ${req.path}`, {
          query: Object.keys(req.query).length > 0 ? req.query : undefined,
          hasAuth: !!req.headers['authorization'],
          userAgent: req.headers['user-agent']?.substring(0, 80),
        });
      }
      next();
    });

    // Health check (public)
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', server: 'clickup-mcp-server-http', version: '0.1.0' });
    });

    // SDK-provided OAuth routes: /.well-known/*, /authorize, /token, /register, /revoke
    const issuerUrl = new URL(process.env.ISSUER_URL || 'https://clickup.ssc.one');
    this.app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: SCOPES.slice(),
    }));

    // Bearer auth middleware for the MCP endpoint
    const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

    // MCP Streamable HTTP endpoint
    this.app.all('/mcp', bearerAuth, async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              console.log(`New MCP session initialized: ${sid}`);
              transports[sid] = transport;
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.log(`Session closed: ${sid}`);
              delete transports[sid];
            }
          };

          const server = this.createServer();
          await server.connect(transport);
          console.log('Transport connected to server');
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Invalid session or missing initialize request' },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });
  }

  async start() {
    const port = parseInt(process.env.PORT || '8767');
    const host = process.env.HOST || '0.0.0.0';

    this.app.listen(port, host, () => {
      console.log(`ClickUp MCP Server HTTP v0.1.0 running on http://${host}:${port}`);
      console.log(`Health check: http://${host}:${port}/health`);
      console.log(`MCP endpoint: http://${host}:${port}/mcp`);
    });
  }
}

// Start the server
const mcpServer = new ClickUpMCPServer();
mcpServer.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});
