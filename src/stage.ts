import type { GameState } from './types.js';

/** Screens shown while joining or changing dimension; the player is not playable yet. */
const LOADING_SCREEN = /LevelLoading|ReceivingLevel|ProgressScreen|ConnectScreen|GenericMessage|DownloadingTerrain/;

/** Screens Forge and NeoForge show when mods fail to load. */
const MOD_ERROR_SCREEN = /LoadingErrorScreen|ModLoadingError/;

/** Game log lines worth reporting when mod loading failed. */
export const MOD_ERROR_LINE = /\/(ERROR|FATAL)\]|Exception|[Mm]issing|requires/;

/** Where the game is, as far as starting and staying connected is concerned. */
export type GameStage = 'mod_error' | 'playing' | 'title' | 'disconnected' | 'loading';

export function gameStage(state: GameState): GameStage {
  const screen = state.screen ?? '';
  if (MOD_ERROR_SCREEN.test(screen)) return 'mod_error';
  if (state.inGame && !state.loading && !LOADING_SCREEN.test(screen)) return 'playing';
  if (screen === 'TitleScreen' && !state.loading) return 'title';
  if (screen === 'DisconnectedScreen') return 'disconnected';
  return 'loading';
}
