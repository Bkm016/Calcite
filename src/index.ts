export { Client, CalciteError, installVersion, parseServer, parseWorld } from './client.js';
export { VideoRecorder } from './recorder.js';
export { executeStoryboard, loadStoryboardFile, validateStoryboard } from './storyboard.js';
export { WindowInput } from './window-input.js';
export type {
  Account,
  BlockFace,
  BlockInfo,
  BlockMatch,
  BlockPosition,
  BlockSearch,
  BlockSearchResult,
  ChatLine,
  ClickMode,
  ClientEvents,
  ClientOptions,
  ClientStatus,
  ContainerInfo,
  CraftResult,
  DigResult,
  EntityInfo,
  EntityQuery,
  ExtensionCommand,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- kept for 0.3 callers
  ExtensionEvent,
  ExtensionInfo,
  GameEvent,
  GameState,
  HitTarget,
  InstallOptions,
  InventoryInfo,
  ItemInfo,
  KeyPressOptions,
  LogLine,
  MouseClickOptions,
  MouseMoveOptions,
  MouseSpace,
  MoveControls,
  NearbyEntity,
  PanLookOptions,
  Phase,
  PlayerState,
  RecordOptions,
  RecordingRegion,
  RecordingResult,
  RecordingStatus,
  RenderMode,
  ServerAddress,
  Storyboard,
  StoryboardResult,
  StoryboardRunOptions,
  StoryboardStep,
  Surroundings,
  TaskStatus,
  TransferResult,
  WalkOptions,
  WalkResult,
  WorldOptions,
} from './client.js';
export { listAccounts, removeAccount, startLogin } from './accounts.js';
export type { AccountInfo, LoginHandle } from './accounts.js';
export { resolvePaths } from './paths.js';
export type { CalcitePaths } from './paths.js';
export { findJavaInstalls, ensureJava } from './java.js';
export type { JavaInstall } from './java.js';
export { resolveVersion } from './mojang.js';
export { setLogLevel } from './log.js';
export { ClientManager } from './manager.js';
export { offlineUuid, startPaperServer } from './paper.js';
export type { PaperServer, PaperServerOptions } from './paper.js';
