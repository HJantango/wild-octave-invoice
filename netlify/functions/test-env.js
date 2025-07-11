exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ? 'SET' : 'NOT SET',
      credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'SET' : 'NOT SET',
      credLength: process.env.GOOGLE_APPLICATION_CREDENTIALS ? process.env.GOOGLE_APPLICATION_CREDENTIALS.length : 0
    })
  };
};