import crypto from 'crypto';

export const generateFingerprint = (userId: string, payload: any) => {
  // Sort keys to avoid false negatives
  const sortedPayload = JSON.stringify(
    Object.keys(payload)
      .sort()
      .reduce((acc: any, key) => {
        acc[key] = payload[key];
        return acc;
      }, {})
  );

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ userId, payload: sortedPayload }))
    .digest('hex');
};
