import express from 'express';
import { AllMediaFetch } from '../controllers/AllMedia.controller.js';

const AllMediaRoutes = express.Router();

AllMediaRoutes.get('/download',AllMediaFetch)
export default AllMediaRoutes;