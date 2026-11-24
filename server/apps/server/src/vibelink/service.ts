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
import { VibeLinkAccountStore } from "./accounts.ts";
import { VibeLinkAuth } from "./auth.ts";
import { VibeLinkClusterManager } from "./cluster.ts";
import { VibeLinkDatabase } from "./db.ts";
import { VibeLinkDeviceHub } from "./devices.ts";
import { VibeLinkOrchestrationBridge } from "./bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "./bridge/terminalBridge.ts";
import { VibeLinkPluginManager } from "./plugins/pluginManager.ts";

export interface VibeLinkServiceShape {
  readonly db: VibeLinkDatabase;
  readonly auth: VibeLinkAuth;
  readonly accounts: VibeLinkAccountStore;
  readonly cluster: VibeLinkClusterManager;
  readonly botHome: BotHomeManager;
  readonly plugins: VibeLinkPluginManager;
  readonly orchestration: VibeLinkOrchestrationBridge;
  readonly terminal: VibeLinkTerminalBridge;
  readonly devices: VibeLinkDeviceHub;
}

function isPluginsDisabledEnv(): boolean {
  return process.env.VIBELINK_DISABLE_PLUGINS === "1";
}

export class VibeLinkService extends Context.Service<
  VibeLinkService,
  VibeLinkServiceShape
>()("t3/vibelink/service/VibeLinkService") {}

export const makeVibeLinkService = Effect.fn("VibeLinkService.make")(function* (options?: {
  readonly homeDir?: string;
  readonly seedPath?: string;
  readonly userPluginsDir?: string;
  readonly bundledPluginsDir?: string;
  readonly disablePlugins?: boolean;
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
  const accounts = new VibeLinkAccountStore(db, db.homeDir);
  const cluster = new VibeLinkClusterManager(db.homeDir, accounts);
  accounts.setMutationListener(() => cluster.schedulePushToStandby());
  cluster.startBackgroundLoop();
  const botHome = new BotHomeManager(db.homeDir);
  runSeedMigration(db, botHome, options?.seedPath);

  const pluginsDisabled =
    Boolean(options?.disablePlugins) || isPluginsDisabledEnv();
  const plugins = new VibeLinkPluginManager(db, botHome, {
    ...(options?.userPluginsDir ? { userPluginsDir: options.userPluginsDir } : {}),
    ...(options?.bundledPluginsDir ? { bundledPluginsDir: options.bundledPluginsDir } : {}),
    ...(pluginsDisabled ? { disableBundled: true, watchIntervalMs: 0 } : {}),
  });

  if (!pluginsDisabled) {
    yield* Effect.promise(() => plugins.initialize()).pipe(Effect.ignore);
  }

  const orchestration = new VibeLinkOrchestrationBridge(
    db,
    botHome,
    threadManagement,
    projectStore,
    projectService,
    plugins,
  );
  const terminal = new VibeLinkTerminalBridge(db, terminalManager);
  const devices = new VibeLinkDeviceHub();

  yield* orchestration.startEventRelay();

  yield* Effect.addFinalizer(() =>
    orchestration.stop().pipe(
      Effect.andThen(
        Effect.sync(() => {
          cluster.stop();
          devices.dispose();
          plugins.stop();
          db.close();
        }),
      ),
    ),
  );

  return {
    db,
    auth,
    accounts,
    cluster,
    botHome,
    plugins,
    orchestration,
    terminal,
    devices,
  } satisfies VibeLinkServiceShape;
});

export const layer = Layer.effect(VibeLinkService, makeVibeLinkService());

export const layerWithOptions = (options: {
  readonly homeDir?: string;
  readonly seedPath?: string;
  readonly userPluginsDir?: string;
  readonly bundledPluginsDir?: string;
  readonly disablePlugins?: boolean;
}) => Layer.effect(VibeLinkService, makeVibeLinkService(options));
