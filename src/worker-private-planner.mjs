import base from './worker-catalogue.mjs';
import {withPrivatePlanner} from './private-planner.mjs';
import {privateSession} from './private-session.mjs';
import javascript from '../public/private-planner.js';
import css from '../public/private-planner.css';

export default withPrivatePlanner(base, {javascript, css}, privateSession);
