export const GITHUB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: '获取 GitHub 用户的基本信息，包括用户名、头像、bio、粉丝数、仓库数等。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub 用户名' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_repos',
      description: '获取 GitHub 用户的仓库列表，包括名称、描述、语言、star 数量等。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub 用户名' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_events',
      description: '获取 GitHub 用户近 90 天的活动事件，包括 PushEvent、WatchEvent、ForkEvent 等。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub 用户名' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_stars',
      description: '获取 GitHub 用户 star 的仓库列表。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub 用户名' },
        },
        required: ['username'],
      },
    },
  },
];
