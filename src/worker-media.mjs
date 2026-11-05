import base from './worker.mjs';
import {withGameMedia} from './game-media.mjs';
import javascript from '../public/game-media.js';
import css from '../public/game-media.css';

export default withGameMedia(base, {javascript, css});
