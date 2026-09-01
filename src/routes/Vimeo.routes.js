import express from 'express';
import { FetchVimeo } from '../controllers/Vimeo.controller.js';

const VimeoRoutes = express.Router();


VimeoRoutes.get('/vimeo',FetchVimeo)
export default VimeoRoutes;