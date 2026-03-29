export interface AggregatedMetrics {
    totalRequests: number;
    successRate: number;
    errorRate: number;
    avgResponseMs: number;
    throughput: number;
  }
  
  export function computeAggregatedMetrics(
    totalRequests: number,
    successCount: number,
    sumResponseMs: number,
    createdAt: string,
    completedAt: string | null
  ): AggregatedMetrics | null {
    if (totalRequests === 0) return null;
  
    const successRate = Math.round((successCount / totalRequests) * 1000) / 10;
    const errorRate = Math.round((100 - successRate) * 10) / 10;
    const avgResponseMs = Math.round(sumResponseMs / totalRequests);
  
    let throughput = 0;
    if (completedAt && createdAt) {
      const durationSec = (new Date(completedAt).getTime() - new Date(createdAt).getTime()) / 1000;
      if (durationSec > 0) {
        throughput = Math.round((totalRequests / durationSec) * 10) / 10;
      }
    }
  
    return {
      totalRequests,
      successRate,
      errorRate,
      avgResponseMs,
      throughput
    };
  }