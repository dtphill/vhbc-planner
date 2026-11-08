import base from './worker-private-planner.mjs';
import {withPlannerSeries} from './planner-series.mjs';
import javascript from '../public/planner-series.js';
import css from '../public/planner-series.css';
export default withPlannerSeries(base,{javascript,css});
