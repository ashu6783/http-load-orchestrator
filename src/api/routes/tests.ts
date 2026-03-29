import express from 'express';
import { testSubmissionLimiter } from '../../utils/rateLimiter';
import { submitTest, getTestById, listTests } from '../controllers/testsController';

const router = express.Router();

// Apply rate limiter to all /tests routes
router.use('/', testSubmissionLimiter);

// Routes
router.post('/', submitTest);
router.get('/:id', getTestById);
router.get('/', listTests);

export default router;
