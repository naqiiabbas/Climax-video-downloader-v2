import express from 'express';
import { DownloadMediaMp4, PrepareDownload } from '../controllers/downloads.controller.js';


const DownloadsRoutes = express.Router();

DownloadsRoutes.get('/mp4', DownloadMediaMp4)
// Handles adaptive sources (YouTube) by downloading and merging video+audio.
DownloadsRoutes.get('/prepare', PrepareDownload)
export default DownloadsRoutes;
