import express from 'express';
import { FetchTiktok } from '../controllers/Tiktok.controller.js';
import { InstaDownloader } from '../controllers/insta.controller.js';



const TiktokRoutes = express.Router();

TiktokRoutes.get('/tiktok',FetchTiktok)
TiktokRoutes.get('/instagram',InstaDownloader)

export default TiktokRoutes;