import base from './worker-series.mjs';
import {withMeetingSizePreferences} from './meeting-size-preferences.mjs';
import javascript from '../public/meeting-size.js';
import css from '../public/meeting-size.css';
export default withMeetingSizePreferences(base,{javascript,css});
