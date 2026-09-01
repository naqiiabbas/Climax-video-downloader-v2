import express from 'express';
import { DalyMotionAndPainternst } from '../controllers/DalyMotion.controller.js';

const DalyMotionRoutes= express.Router();
DalyMotionRoutes.get('/dailymotion',DalyMotionAndPainternst)
export default DalyMotionRoutes;