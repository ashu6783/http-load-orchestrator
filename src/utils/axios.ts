import axios from 'axios';
import axiosRetry from 'axios-retry';

export const axiosInstance = axios.create({
  timeout: 10000
});

axiosRetry(axiosInstance, { retries: 2, retryDelay: axiosRetry.exponentialDelay });
