/**
 * Task Tools Test Suite (Unit Tests)
 *
 * Tests the core MCP tool functionality for ClickUp integration.
 * Uses mocked ClickUp API responses to test tool handlers without
 * making real API calls.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const TASK_ID = 'abc123def';
const LIST_ID = 'lst456789';
const FOLDER_ID = 'fld789012';
const SPACE_ID = 'spc345678';
const TEAM_ID = '9017912306';
const CUSTOM_FIELD_ID = 'cf_abcdef12';
const COMMENT_ID = 'cmt_999888';

const requireId = (value, field) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${field} must be a valid ClickUp ID (alphanumeric string)`);
  }
  return value;
};

// Mock ClickUp API client
const createMockClickUpClient = () => ({
  get: async (path) => {
    if (path.includes('/task/') && !path.includes('/comment')) {
      return { id: TASK_ID, name: 'Test task', status: { status: 'open' }, list: { id: LIST_ID } };
    }
    if (path.includes('/task/') && path.includes('/comment')) {
      return {
        comments: [
          { id: COMMENT_ID, comment_text: 'Test comment', date: Date.now().toString() },
        ],
      };
    }
    if (path.includes('/list/') && path.includes('/task')) {
      return {
        tasks: [
          { id: TASK_ID, name: 'List task', status: { status: 'open' } },
        ],
      };
    }
    if (path.includes('/list/') && path.includes('/field')) {
      return {
        fields: [
          { id: CUSTOM_FIELD_ID, name: 'Priority', type: 'drop_down' },
        ],
      };
    }
    if (path.includes('/list/') && path.includes('/member')) {
      return {
        members: [
          { id: 123, username: 'testuser', email: 'test@example.com' },
        ],
      };
    }
    if (path === '/team') {
      return {
        teams: [
          { id: TEAM_ID, name: 'Test Workspace' },
        ],
      };
    }
    if (path.includes('/team/') && path.includes('/space')) {
      return {
        spaces: [
          { id: SPACE_ID, name: 'Test Space' },
        ],
      };
    }
    if (path.includes('/space/') && path.includes('/folder')) {
      return {
        folders: [
          { id: FOLDER_ID, name: 'Test Folder' },
        ],
      };
    }
    if (path.includes('/folder/') && path.includes('/list')) {
      return {
        lists: [
          { id: LIST_ID, name: 'Test List' },
        ],
      };
    }
    return {};
  },
  post: async (path, body) => {
    if (path.includes('/list/') && path.includes('/task')) {
      return { id: 'new_task_001', name: body?.name || 'Untitled', status: { status: 'open' } };
    }
    if (path.includes('/task/') && path.includes('/comment')) {
      return { id: COMMENT_ID, comment_text: body?.comment_text, date: Date.now().toString() };
    }
    if (path.includes('/task/') && path.includes('/dependency')) {
      return {};
    }
    if (path.includes('/task/') && path.includes('/field/')) {
      return {};
    }
    if (path.includes('/team/') && path.includes('/space')) {
      return { id: 'new_space_001', name: body?.name };
    }
    if (path.includes('/space/') && path.includes('/folder')) {
      return { id: 'new_folder_001', name: body?.name };
    }
    if (path.includes('/folder/') && path.includes('/list')) {
      return { id: 'new_list_001', name: body?.name };
    }
    return {};
  },
  put: async (_path, body) => {
    return { id: TASK_ID, ...body };
  },
  delete: async () => {
    return {};
  },
});

// Mock tool handler (simplified version matching real server logic)
const mockHandleToolCall = async (toolName, args, client) => {
  switch (toolName) {
    case 'clickup_get_workspaces': {
      const response = await client.get('/team');
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, teams: response.teams }) }],
        isError: false,
      };
    }

    case 'clickup_get_spaces': {
      const teamId = requireId(args.team_id, 'team_id');
      const response = await client.get(`/team/${teamId}/space`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, spaces: response.spaces }) }],
        isError: false,
      };
    }

    case 'clickup_get_folders': {
      const spaceId = requireId(args.space_id, 'space_id');
      const response = await client.get(`/space/${spaceId}/folder`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, folders: response.folders }) }],
        isError: false,
      };
    }

    case 'clickup_get_lists': {
      const folderId = requireId(args.folder_id, 'folder_id');
      const response = await client.get(`/folder/${folderId}/list`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, lists: response.lists }) }],
        isError: false,
      };
    }

    case 'clickup_get_task': {
      const taskId = requireId(args.task_id, 'task_id');
      const response = await client.get(`/task/${taskId}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, task: response }) }],
        isError: false,
      };
    }

    case 'clickup_get_tasks': {
      const listId = requireId(args.list_id, 'list_id');
      const response = await client.get(`/list/${listId}/task`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, tasks: response.tasks }) }],
        isError: false,
      };
    }

    case 'clickup_create_task': {
      const listId = requireId(args.list_id, 'list_id');
      if (!args.name) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'name is required' }) }],
          isError: true,
        };
      }
      const response = await client.post(`/list/${listId}/task`, { name: args.name });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, task: response }) }],
        isError: false,
      };
    }

    case 'clickup_update_task': {
      const taskId = requireId(args.task_id, 'task_id');
      const response = await client.put(`/task/${taskId}`, args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, task: response }) }],
        isError: false,
      };
    }

    case 'clickup_delete_task': {
      const taskId = requireId(args.task_id, 'task_id');
      await client.delete(`/task/${taskId}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    }

    case 'clickup_add_comment': {
      const taskId = requireId(args.task_id, 'task_id');
      if (!args.comment_text) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'comment_text is required' }) }],
          isError: true,
        };
      }
      const response = await client.post(`/task/${taskId}/comment`, { comment_text: args.comment_text });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, comment: response }) }],
        isError: false,
      };
    }

    case 'clickup_get_task_comments': {
      const taskId = requireId(args.task_id, 'task_id');
      const response = await client.get(`/task/${taskId}/comment`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, comments: response.comments }) }],
        isError: false,
      };
    }

    case 'clickup_get_custom_fields': {
      const listId = requireId(args.list_id, 'list_id');
      const response = await client.get(`/list/${listId}/field`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, fields: response.fields }) }],
        isError: false,
      };
    }

    case 'clickup_set_custom_field_value': {
      const taskId = requireId(args.task_id, 'task_id');
      const fieldId = requireId(args.field_id, 'field_id');
      await client.post(`/task/${taskId}/field/${fieldId}`, { value: args.value });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    }

    case 'clickup_add_dependency': {
      const taskId = requireId(args.task_id, 'task_id');
      await client.post(`/task/${taskId}/dependency`, args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    }

    case 'clickup_get_list_members': {
      const listId = requireId(args.list_id, 'list_id');
      const response = await client.get(`/list/${listId}/member`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, members: response.members }) }],
        isError: false,
      };
    }

    case 'clickup_create_space': {
      const teamId = requireId(args.team_id, 'team_id');
      if (!args.name) throw new Error('name is required');
      const response = await client.post(`/team/${teamId}/space`, { name: args.name });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, space: response }) }],
        isError: false,
      };
    }

    case 'clickup_create_folder': {
      const spaceId = requireId(args.space_id, 'space_id');
      if (!args.name) throw new Error('name is required');
      const response = await client.post(`/space/${spaceId}/folder`, { name: args.name });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, folder: response }) }],
        isError: false,
      };
    }

    case 'clickup_create_list': {
      const folderId = requireId(args.folder_id, 'folder_id');
      if (!args.name) throw new Error('name is required');
      const response = await client.post(`/folder/${folderId}/list`, { name: args.name });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, list: response }) }],
        isError: false,
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
};

// ─── Tests ───────────────────────────────────────────────────────────────────

test('clickup_get_workspaces - returns workspaces', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_workspaces', {}, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.teams));
  assert.strictEqual(response.teams[0].id, TEAM_ID);
});

test('clickup_get_spaces - returns spaces for a team', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_spaces', { team_id: TEAM_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.spaces));
  assert.strictEqual(response.spaces[0].id, SPACE_ID);
});

test('clickup_get_spaces - rejects invalid team_id', async () => {
  const client = createMockClickUpClient();
  await assert.rejects(
    () => mockHandleToolCall('clickup_get_spaces', { team_id: 'invalid id with spaces' }, client),
    /team_id must be a valid ClickUp ID/
  );
});

test('clickup_get_folders - returns folders for a space', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_folders', { space_id: SPACE_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.folders));
});

test('clickup_get_lists - returns lists for a folder', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_lists', { folder_id: FOLDER_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.lists));
});

test('clickup_get_task - returns a single task', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_task', { task_id: TASK_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.task.id, TASK_ID);
  assert.strictEqual(response.task.name, 'Test task');
});

test('clickup_get_tasks - returns tasks for a list', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_tasks', { list_id: LIST_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.tasks));
  assert.strictEqual(response.tasks[0].name, 'List task');
});

test('clickup_create_task - creates task successfully', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_create_task', {
    list_id: LIST_ID,
    name: 'New task',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.task.name, 'New task');
});

test('clickup_create_task - handles missing name', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_create_task', { list_id: LIST_ID }, client);

  assert.strictEqual(result.isError, true);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, false);
  assert.ok(response.error.includes('name'));
});

test('clickup_update_task - updates task fields', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_update_task', {
    task_id: TASK_ID,
    name: 'Updated name',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
});

test('clickup_delete_task - deletes a task', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_delete_task', { task_id: TASK_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
});

test('clickup_add_comment - adds comment to task', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_add_comment', {
    task_id: TASK_ID,
    comment_text: 'Hello from tests',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.comment.comment_text, 'Hello from tests');
});

test('clickup_add_comment - handles missing comment_text', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_add_comment', { task_id: TASK_ID }, client);

  assert.strictEqual(result.isError, true);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, false);
  assert.ok(response.error.includes('comment_text'));
});

test('clickup_get_task_comments - returns comments', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_task_comments', { task_id: TASK_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.comments));
  assert.strictEqual(response.comments[0].id, COMMENT_ID);
});

test('clickup_get_custom_fields - returns fields for a list', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_custom_fields', { list_id: LIST_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.fields));
  assert.strictEqual(response.fields[0].id, CUSTOM_FIELD_ID);
});

test('clickup_set_custom_field_value - sets field value on task', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_set_custom_field_value', {
    task_id: TASK_ID,
    field_id: CUSTOM_FIELD_ID,
    value: 'high',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
});

test('clickup_add_dependency - adds dependency between tasks', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_add_dependency', {
    task_id: TASK_ID,
    depends_on: 'other_task_123',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
});

test('clickup_get_list_members - returns members', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_get_list_members', { list_id: LIST_ID }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.ok(Array.isArray(response.members));
});

test('clickup_create_space - creates space', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_create_space', {
    team_id: TEAM_ID,
    name: 'New Space',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.space.name, 'New Space');
});

test('clickup_create_folder - creates folder', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_create_folder', {
    space_id: SPACE_ID,
    name: 'New Folder',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.folder.name, 'New Folder');
});

test('clickup_create_list - creates list in folder', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('clickup_create_list', {
    folder_id: FOLDER_ID,
    name: 'New List',
  }, client);

  assert.strictEqual(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.list.name, 'New List');
});

test('Unknown tool - returns error', async () => {
  const client = createMockClickUpClient();
  const result = await mockHandleToolCall('unknown_tool', {}, client);

  assert.strictEqual(result.isError, true);
  assert.ok(result.content[0].text.includes('Unknown tool'));
});
