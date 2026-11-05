import base from './worker-media.mjs';
import {withActiveCatalogue} from './active-catalogue.mjs';
import {withCommunityTools} from './community-tools.mjs';
import javascript from '../public/community-tools.js';
import css from '../public/community-tools.css';

export default withCommunityTools(withActiveCatalogue(base), {javascript, css});
