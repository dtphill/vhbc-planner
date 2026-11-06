import base from './worker-community.mjs';
import {withPrearrangedTables} from './prearranged-tables.mjs';
import javascript from '../public/prearranged.js';
import css from '../public/prearranged.css';

export default withPrearrangedTables(base, {javascript, css});
