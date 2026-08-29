// Entry point for the public log at /. Wiring only: the fleet's convention
// keeps app.js under 50 lines and puts the work in named modules.
import { initLog } from './log.js';

initLog();
