/** Browser entry for web/verify.html: `npm run build:web` bundles this to web/verifier.bundle.js. */
import { loadFromChain, verifyMission } from "./core";
import { NETWORK_DEFAULTS } from "./networks";

(globalThis as any).BlackboxVerifier = { loadFromChain, verifyMission, NETWORK_DEFAULTS };
