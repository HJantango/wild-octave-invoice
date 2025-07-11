// netlify/functions/process-invoice.js - Real OCR version
const { ImageAnnotatorClient } = require('@google-cloud/vision');

// Initialize Google Vision client
let vision;
try {
  // Decode the base64 credentials
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'base64').toString()
  );
  
  vision = new ImageAnnotatorClient({
    credentials: credentials,
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  });
} catch (error) {
  console.error('Failed to initialize Google Vision:', error);
}

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
    console.log('Processing invoice with Google Vision...');
    
    if (!vision) {
      throw new Error('Google Vision not properly configured. Check environment variables.');
    }

    // Parse multipart form data
    const boundary = event.headers['content-type'].split('boundary=')[1];
    const parts = parseMultipartForm(event.body, boundary);
    
    const file = parts.file;
    const provider = parts.provider;

    if (!file) {
      throw new Error('No file uploaded');
    }

    console.log(`Processing with provider: ${provider}`);
    console.log(`File size: ${file.data.length} bytes`);

    // Process with Google Vision
    const result = await processWithGoogleVision(file);
    
    console.log('OCR processing complete:', result);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('OCR processing error:', error);
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

async function processWithGoogleVision(file) {
  try {
    console.log('Starting Google Vision text detection...');
    
    // Convert base64 to buffer if needed
    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    
    // Perform text detection
    const [result] = await vision.textDetection({
      image: { content: imageBuffer }
    });

    const detections = result.textAnnotations;
    if (!detections || detections.length === 0) {
      throw new Error('No text detected in the image');
    }

    const fullText = detections[0].description;
    console.log('Extracted text length:', fullText.length);
    
    // Parse the extracted text to find invoice data
    const parsedData = parseInvoiceText(fullText);
    
    return {
      supplier: parsedData.supplier,
      items: parsedData.items,
      rawText: fullText.substring(0, 500) + '...' // First 500 chars for debugging
    };

  } catch (error) {
    console.error('Google Vision error:', error);
    throw new Error(`Google Vision processing failed: ${error.message}`);
  }
}

function parseInvoiceText(text) {
  console.log('Parsing invoice text...');
  
  const lines = text.split('\n').filter(line => line.trim());
  console.log(`Processing ${lines.length} lines of text`);
  
  // Try to find supplier name (usually at the top)
  let supplier = 'Unknown Supplier';
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim();
    // Skip obvious non-supplier lines
    if (line.length > 5 && 
        !line.match(/^\d+/) && 
        !line.toLowerCase().includes('invoice') &&
        !line.toLowerCase().includes('tax') &&
        !line.toLowerCase().includes('gst') &&
        !line.toLowerCase().includes('date') &&
        !line.match(/^\$/) &&
        !line.match(/\d{2}\/\d{2}\/\d{4}/)) {
      supplier = line;
      console.log('Found supplier:', supplier);
      break;
    }
  }

  // Enhanced item parsing - look for various patterns
  const items = [];
  
  // Pattern 1: Product Quantity Unit Price (most common)
  const pattern1 = /(.+?)\s+(\d+(?:\.\d+)?)\s+(\w+)?\s*\$?(\d+(?:\.\d+)?)/;
  
  // Pattern 2: Product $Price Quantity
  const pattern2 = /(.+?)\s+\$(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/;
  
  // Pattern 3: Just Product and Price
  const pattern3 = /(.+?)\s+\$(\d+(?:\.\d+)?)/;

  for (const line of lines) {
    const cleanLine = line.trim();
    
    // Skip obvious header/footer lines
    if (cleanLine.toLowerCase().includes('invoice') ||
        cleanLine.toLowerCase().includes('total') ||
        cleanLine.toLowerCase().includes('subtotal') ||
        cleanLine.toLowerCase().includes('gst') ||
        cleanLine.toLowerCase().includes('tax') ||
        cleanLine.match(/^\d{2}\/\d{2}\/\d{4}/) ||
        cleanLine.length < 3) {
      continue;
    }

    // Try pattern 1 first
    let match = cleanLine.match(pattern1);
    if (match) {
      const [, description, quantity, unit, price] = match;
      items.push({
        description: description.trim(),
        quantity: parseFloat(quantity),
        unitPrice: parseFloat(price),
        unit: unit || 'each'
      });
      console.log('Pattern 1 match:', { description: description.trim(), quantity, price });
      continue;
    }

    // Try pattern 2
    match = cleanLine.match(pattern2);
    if (match) {
      const [, description, price, quantity] = match;
      items.push({
        description: description.trim(),
        quantity: parseFloat(quantity),
        unitPrice: parseFloat(price),
        unit: 'each'
      });
      console.log('Pattern 2 match:', { description: description.trim(), quantity, price });
      continue;
    }

    // Try pattern 3 (assume quantity 1)
    match = cleanLine.match(pattern3);
    if (match && parseFloat(match[2]) > 0.50) { // Only if price > $0.50
      const [, description, price] = match;
      items.push({
        description: description.trim(),
        quantity: 1,
        unitPrice: parseFloat(price),
        unit: 'each'
      });
      console.log('Pattern 3 match:', { description: description.trim(), price });
    }
  }

  // If no structured items found, create fallback items from price patterns
  if (items.length === 0) {
    console.log('No structured items found, looking for price patterns...');
    const priceMatches = text.match(/\$\d+(?:\.\d+)?/g);
    if (priceMatches && priceMatches.length > 0) {
      // Take the first few prices and create generic items
      priceMatches.slice(0, 3).forEach((priceStr, index) => {
        const price = parseFloat(priceStr.replace('$', ''));
        if (price > 0.50) { // Reasonable minimum price
          items.push({
            description: `Invoice Item ${index + 1}`,
            quantity: 1,
            unitPrice: price,
            unit: 'each'
          });
        }
      });
    }
  }

  console.log(`Parsed ${items.length} items from invoice`);
  return { supplier, items };
}

function parseMultipartForm(body, boundary) {
  const parts = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const bodyBuffer = Buffer.from(body, 'base64');
  
  // Split by boundary
  const sections = [];
  let start = 0;
  let boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, start);
  
  while (boundaryIndex !== -1) {
    if (start !== boundaryIndex) {
      sections.push(bodyBuffer.slice(start, boundaryIndex));
    }
    start = boundaryIndex + boundaryBuffer.length;
    boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, start);
  }
  
  // Parse each section
  for (const section of sections) {
    if (section.length === 0) continue;
    
    const headerEndIndex = section.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) continue;
    
    const headers = section.slice(0, headerEndIndex).toString();
    const content = section.slice(headerEndIndex + 4);
    
    // Extract field name
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    
    const fieldName = nameMatch[1];
    
    if (fieldName === 'file') {
      // Extract filename and content type
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/);
      
      parts.file = {
        filename: filenameMatch ? filenameMatch[1] : 'uploaded_file',
        contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
        data: content
      };
    } else {
      // Regular form field
      parts[fieldName] = content.toString().trim();
    }
  }
  
  return parts;
}
