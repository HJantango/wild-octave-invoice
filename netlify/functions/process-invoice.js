// netlify/functions/process-invoice.js - Fixed version
exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  try {
    console.log('Function called successfully');
    
    // Return mock data to test if the function works
    const mockResult = {
      supplier: "Test Supplier from OCR",
      items: [
        {
          description: "Test Product 1",
          quantity: 5,
          unitPrice: 10.50,
          unit: "each"
        },
        {
          description: "Test Product 2", 
          quantity: 2,
          unitPrice: 25.00,
          unit: "kg"
        }
      ]
    };

    console.log('Returning mock result:', mockResult);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(mockResult)
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        details: 'Check function logs for more information'
      })
    };
  }
};
