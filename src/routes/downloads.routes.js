import express from 'express';
import { DownloadMediaMp4 } from '../controllers/downloads.controller.js';


const DownloadsRoutes = express.Router();

DownloadsRoutes.get('/mp4',DownloadMediaMp4)
export default DownloadsRoutes;
