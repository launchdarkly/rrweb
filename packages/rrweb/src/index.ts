import record from './record';
import {
  Replayer,
  type playerConfig,
  type PlayerMachineState,
  type SpeedMachineState,
} from './replay';
import canvasMutation from './replay/canvas';
import { _mirror } from './utils';
import * as utils from './utils';

export {
  EventType,
  IncrementalSource,
  MouseInteractions,
  ReplayerEvents,
  type eventWithTime,
} from '@rrweb/types';

// exports style.css from replay
import './replay/styles/style.css';

export type { recordOptions, ReplayPlugin } from './types';

// Origin-isolated replay: run the Replayer inside a cookieless, cross-origin
// iframe and drive it over postMessage (SEC-8885). See ./replay/embedded.
export {
  EmbeddedReplayerHost,
  startEmbeddedReplayerHost,
  EmbeddedReplayerClient,
  buildHostDocument,
  pickSerializableConfig,
  RRWEB_EMBEDDED_CHANNEL,
  RRWEB_EMBEDDED_PROTOCOL_VERSION,
  type EmbeddedReplayerHostOptions,
  type EmbeddedReplayerClientOptions,
  type HostDocumentOptions,
  type SerializableReplayerConfig,
  type HostCommand,
  type HostMessage,
} from './replay/embedded';

const { addCustomEvent } = record;
const { freezePage } = record;
const { takeFullSnapshot } = record;

export {
  record,
  addCustomEvent,
  freezePage,
  takeFullSnapshot,
  Replayer,
  type playerConfig,
  type PlayerMachineState,
  type SpeedMachineState,
  canvasMutation,
  _mirror as mirror,
  utils,
};
