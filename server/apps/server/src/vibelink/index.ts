import * as Layer from "effect/Layer";

import { vibelinkHttpRoutes } from "./http.ts";
import { vibelinkWsRoutes } from "./ws.ts";

export * as VibeLinkService from "./service.ts";
export {
  VibeLinkCollaborationToolkit,
  layerVibeLinkCollaborationHandlers,
} from "./bridge/mcpCollaborationTools.ts";
export { dispatchVibeLinkHttp } from "./http.ts";
export { extractGroupBotMentions, MAX_GROUP_HANDOFFS } from "./bots/botGroupMentions.ts";
export { BotHomeManager } from "./bots/botHome.ts";
export { appendBotMemoryFact, MAX_MEMORY_FACTS, tidyBotMemory } from "./bots/botMemory.ts";
export { runSeedMigration } from "./bots/botMigration.ts";
export { VibeLinkDatabase } from "./db.ts";
export { VibeLinkAuth } from "./auth.ts";

export const layer = Layer.mergeAll(vibelinkHttpRoutes, vibelinkWsRoutes);
