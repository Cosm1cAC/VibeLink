import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { BotHomeManager } from "./bots/botHome.ts";
import { runSeedMigration } from "./bots/botMigration.ts";
import { VibeLinkAuth } from "./auth.ts";
import { VibeLinkDatabase } from "./db.ts";
import { VibeLinkOrchestrationBridge } from "./bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "./bridge/terminalBridge.ts";

export interface VibeLinkServiceShape {
  readonly db: VibeLinkDatabase;
  readonly auth: VibeLinkAuth;
  readonly botHome: BotHomeManager;
  readonly orchestration: VibeLinkOrchestrationBridge;
  readonly terminal: VibeLinkTerminalBridge;
}

export class VibeLinkService extends Context.Service<
  VibeLinkService,
  VibeLinkServiceShape
>()("t3/vibelink/service/VibeLinkService") {}

export const makeVibeLinkService = Effect.fn("VibeLinkService.make")(function* (options?: {
  readonly homeDir?: string;
  readonly seedPath?: string;
}) {
  const threadManagement = Option.getOrNull(
    yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService),
  );
  const projectStore = Option.getOrNull(yield* Effect.serviceOption(ProjectStore.ProjectStoreV2));
  const projectService = Option.getOrNull(yield* Effect.serviceOption(ProjectService.ProjectService));
  const terminalManager = Option.getOrNull(
    yield* Effect.serviceOption(TerminalManager.TerminalManager),
  );

  const db = new VibeLinkDatabase(options?.homeDir);
  const auth = new VibeLinkAuth(db.homeDir);
  const botHome = new BotHomeManager(db.homeDir);
  runSeedMigration(db, botHome, options?.seedPath);

  const orchestration = new VibeLinkOrchestrationBridge(
    db,
    botHome,
    threadManagement,
    projectStore,
    projectService,
  );
  const terminal = new VibeLinkTerminalBridge(db, terminalManager);

  yield* orchestration.startEventRelay();

  yield* Effect.addFinalizer(() =>
    orchestration.stop().pipe(
      Effect.andThen(
        Effect.sync(() => {
          db.close();
        }),
      ),
    ),
  );

  return {
    db,
    auth,
    botHome,
    orchestration,
    terminal,
  } satisfies VibeLinkServiceShape;
});

export const layer = Layer.effect(VibeLinkService, makeVibeLinkService());

export const layerWithOptions = (options: {
  readonly homeDir?: string;
  readonly seedPath?: string;
}) => Layer.effect(VibeLinkService, makeVibeLinkService(options));
