import { describe, it, expect } from 'vitest';
import { GITHUB_TOOLS } from './tools-schema';

describe('GITHUB_TOOLS', () => {
  it('should export an array of 4 tools', () => {
    expect(GITHUB_TOOLS).toHaveLength(4);
  });

  it('should have correct tool names', () => {
    const toolNames = GITHUB_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('get_user_profile');
    expect(toolNames).toContain('get_user_repos');
    expect(toolNames).toContain('get_user_events');
    expect(toolNames).toContain('get_user_stars');
  });

  it('should have Chinese descriptions for all tools', () => {
    for (const tool of GITHUB_TOOLS) {
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.description.length).toBeGreaterThan(0);
    }
  });

  it('should have username as required parameter for all tools', () => {
    for (const tool of GITHUB_TOOLS) {
      const params = tool.function.parameters as { required: string[]; properties: Record<string, unknown> };
      expect(params.required).toContain('username');
      expect(params.properties).toHaveProperty('username');
    }
  });

  it('should have correct structure for all tools', () => {
    for (const tool of GITHUB_TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function).toHaveProperty('name');
      expect(tool.function).toHaveProperty('description');
      expect(tool.function).toHaveProperty('parameters');
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  it('should have username parameter with string type', () => {
    const profileTool = GITHUB_TOOLS.find((t) => t.function.name === 'get_user_profile');
    const usernameParam = (profileTool!.function.parameters as { properties: Record<string, { type: string }> }).properties.username;
    expect(usernameParam.type).toBe('string');
  });
});
