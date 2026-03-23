/**
 * Integration Test Suite
 *
 * Tests the actual running server at https://clickup.ssc.one
 */

import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { acquireTestServer, releaseTestServer } from '../helpers/test-server.js';

const DEFAULT_BASE_URL = 'https://clickup.ssc.one';
let baseUrl = process.env.TEST_BASE_URL || DEFAULT_BASE_URL;
let serverInfo;
let skipSuite = false;

before(async () => {
  try {
    serverInfo = await acquireTestServer();
    baseUrl = serverInfo.baseUrl;
  } catch (error) {
    skipSuite = true;
    console.warn(`⚠️  Skipping integration tests: ${error instanceof Error ? error.message : error}`);
  }
});

after(async () => {
  if (!skipSuite) {
    await releaseTestServer();
  }
});

function getAuthHeaders() {
  const token =
    serverInfo?.token ||
    process.env.MCP_ALLOWED_TOKENS?.split(',')[0]?.trim();
  return token
    ? {
        Authorization: `Bearer ${token}`,
      }
    : {};
}

// ─── Helper: initialize an MCP session ───────────────────────────────────────
async function initSession() {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });

  const sessionId = response.headers.get('mcp-session-id');
  return { response, sessionId };
}

// ─── Helper: call an MCP tool ────────────────────────────────────────────────
async function callTool(sessionId, toolName, args = {}, id = 3) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  assert.strictEqual(response.ok, true, `tools/call ${toolName} should return 200`);

  const text = await response.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  const toolResult = data.result?.content?.[0]?.text;
  assert.ok(toolResult, `Tool ${toolName} should return content`);

  return JSON.parse(toolResult);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('Health check endpoint responds', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const response = await fetch(`${baseUrl}/health`);
  assert.strictEqual(response.ok, true, 'Health endpoint should return 200');

  const data = await response.json();
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.server, 'clickup-mcp-server-http');
});

test('MCP unauthorized without bearer token', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
  assert.strictEqual(response.status, 401, 'Unauthorized should return 401');
});

test('MCP initialize creates session (authorized)', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { response, sessionId } = await initSession();

  assert.strictEqual(response.ok, true, 'Initialize should return 200');
  assert.ok(sessionId, 'Should return session ID in header');

  const text = await response.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  assert.strictEqual(data.result.serverInfo.name, 'clickup-mcp-server-http');
});

test('MCP tools/list includes ClickUp tools (authorized)', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  assert.ok(sessionId, 'Should have session ID');

  const toolsResponse = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }),
  });

  assert.strictEqual(toolsResponse.ok, true, 'tools/list should return 200');

  const text = await toolsResponse.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  const toolNames = data.result.tools.map(t => t.name);

  assert.ok(toolNames.includes('clickup_create_task'), 'Should include clickup_create_task');
  assert.ok(toolNames.includes('clickup_get_tasks'), 'Should include clickup_get_tasks');
  assert.ok(toolNames.includes('clickup_get_workspaces'), 'Should include clickup_get_workspaces');
  assert.ok(toolNames.includes('clickup_get_spaces'), 'Should include clickup_get_spaces');
  assert.ok(toolNames.includes('clickup_create_folder'), 'Should include clickup_create_folder');
  assert.ok(toolNames.includes('clickup_create_list'), 'Should include clickup_create_list');
  assert.ok(toolNames.includes('clickup_set_custom_field_value'), 'Should include clickup_set_custom_field_value');
  assert.ok(toolNames.includes('clickup_add_dependency'), 'Should include clickup_add_dependency');
  assert.ok(toolNames.every(name => name.startsWith('clickup_')), 'All tool names should be clickup_* prefixed');

  console.log(`✅ Found ${toolNames.length} ClickUp tools`);
});

test('clickup_get_workspaces - returns workspaces from live API', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'clickup_get_workspaces');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.workspaces, 'Should return workspaces');

  const workspaces = result.workspaces;
  assert.ok(Array.isArray(workspaces), 'Workspaces should be an array');
  assert.ok(workspaces.length > 0, 'Should have at least one workspace');

  console.log(`✅ Found ${workspaces.length} workspace(s): ${workspaces.map(w => w.name).join(', ')}`);
});

test('clickup_get_spaces - returns spaces for first workspace', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();

  // First get workspaces to find a team_id
  const wsResult = await callTool(sessionId, 'clickup_get_workspaces', {}, 3);
  const workspaces = wsResult.workspaces;
  assert.ok(workspaces.length > 0, 'Need at least one workspace');
  const teamId = workspaces[0].id;

  // Get spaces
  const result = await callTool(sessionId, 'clickup_get_spaces', { team_id: String(teamId) }, 4);
  assert.strictEqual(result.success, true, 'Should succeed');

  const spaces = result.spaces;
  assert.ok(Array.isArray(spaces), 'Spaces should be an array');

  console.log(`✅ Found ${spaces.length} space(s) in workspace "${workspaces[0].name}"`);
});

test('clickup_get_task - returns error for invalid task ID', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'clickup_get_task', { task_id: 'nonexistent_fake_id_999' }, 3);

  // Should return an error from the ClickUp API
  assert.strictEqual(result.success, false, 'Should fail for invalid task ID');
});

test('clickup_search_tasks - searches tasks across workspace', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();

  // Get workspace ID first
  const wsResult = await callTool(sessionId, 'clickup_get_workspaces', {}, 3);
  const teamId = wsResult.workspaces[0].id;

  const result = await callTool(sessionId, 'clickup_search_tasks', {
    team_id: String(teamId),
    page: 0,
  }, 4);

  assert.strictEqual(result.success, true, 'Search should succeed');
  const tasks = result.tasks;
  assert.ok(Array.isArray(tasks), 'Tasks should be an array');

  console.log(`✅ Search returned ${tasks.length} task(s)`);
});
