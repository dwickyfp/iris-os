import { pgChatRepository } from "./pg/repositories/chat-repository.pg";
import { pgUserRepository } from "./pg/repositories/user-repository.pg";
import { pgMcpRepository } from "./pg/repositories/mcp-repository.pg";
import { pgMcpMcpToolCustomizationRepository } from "./pg/repositories/mcp-tool-customization-repository.pg";
import { pgMcpServerCustomizationRepository } from "./pg/repositories/mcp-server-customization-repository.pg";
import { pgWorkflowRepository } from "./pg/repositories/workflow-repository.pg";
import { pgAgentRepository } from "./pg/repositories/agent-repository.pg";
import { pgArchiveRepository } from "./pg/repositories/archive-repository.pg";
import { pgMcpOAuthRepository } from "./pg/repositories/mcp-oauth-repository.pg";
import { pgBookmarkRepository } from "./pg/repositories/bookmark-repository.pg";
import { pgChatExportRepository } from "./pg/repositories/chat-export-repository.pg";
import { pgSkillRepository } from "./pg/repositories/skill-repository.pg";
import { pgMemoryRepository } from "./pg/repositories/memory-repository.pg";
import { pgMemoryGraphRepository } from "./pg/repositories/memory-graph-repository.pg";
import { pgWorkspaceRepository } from "./pg/repositories/workspace-repository.pg";
import { pgTaskRepository } from "./pg/repositories/task-repository.pg";

export const chatRepository = pgChatRepository;
export const userRepository = pgUserRepository;
export const mcpRepository = pgMcpRepository;
export const mcpMcpToolCustomizationRepository =
  pgMcpMcpToolCustomizationRepository;
export const mcpServerCustomizationRepository =
  pgMcpServerCustomizationRepository;
export const mcpOAuthRepository = pgMcpOAuthRepository;

export const workflowRepository = pgWorkflowRepository;
export const agentRepository = pgAgentRepository;
export const skillRepository = pgSkillRepository;
export const archiveRepository = pgArchiveRepository;
export const bookmarkRepository = pgBookmarkRepository;
export const chatExportRepository = pgChatExportRepository;
export const memoryRepository = pgMemoryRepository;
export const memoryGraphRepository = pgMemoryGraphRepository;
export const workspaceRepository = pgWorkspaceRepository;
export const taskRepository = pgTaskRepository;
