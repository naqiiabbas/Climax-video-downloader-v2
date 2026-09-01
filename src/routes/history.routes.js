import express from "express";
import {
  AddHistory,
  ListHistory,
  DeleteHistory,
  ClearHistory,
  HistoryStatus,
} from "../controllers/history.controller.js";

const HistoryRoutes = express.Router();

// Lets the app decide whether to show a History tab at all.
HistoryRoutes.get("/status", HistoryStatus);

HistoryRoutes.get("/", ListHistory);
HistoryRoutes.post("/", AddHistory);
HistoryRoutes.delete("/", ClearHistory);
HistoryRoutes.delete("/:id", DeleteHistory);

export default HistoryRoutes;
