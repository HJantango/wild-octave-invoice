// netlify/functions/process-invoice.js - Working version
exports.handler = async (event, context) => {
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
    console.log('Starting invoice processing...');
    
    // Initialize Google Vision with proper error handling
    let vision;
    try {
      const { ImageAnnotatorClient } = require('@google-cloud/vision');
      
      // Decode credentials from base64
      const credentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
      
      console.log('Decoding credentials...');
      const credentialsJson = Buffer.from(credentialsBase64, 'base64').toString();
      const credentials = JSON.parse(credentialsJson);
      
      console.log('Creating Vision client...');
      vision = new ImageAnnotatorClient({
        credentials: credentials,
        projectId: projectId,
      });
      
      console.log('Vision client created successfully');
      
    } catch (initError) {
      console.error('Failed to initialize Google Vision:', initError);
      throw new Error(`Google Vision initialization failed: ${initError.message}`);
    }

    // Parse the uploaded file
    console.log('Parsing uploaded file...');
    const boundary = event.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      throw new Error('No boundary found in content-type header');
    }
    
    const parts = parseMultipartForm(event.body, boundary);
    const file = parts.file;
    
    if (!file) {
      throw new Error('No file uploaded');
    }

    console.log(`Processing file: ${file.filename}, size: ${file.data.length} bytes`);

    // Process with Google Vision
    const result = await processWithGoogleVision(vision, file);
    
    console.log('OCR processing complete, returning result');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Invoice processing error:', error);
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

async function processWithGoogleVision(vision, file) {
  try {
    console.log('Starting Google Vision text detection...');
    
    // Convert to buffer
    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    console.log(`Image buffer size: ${imageBuffer.length} bytes`);
    
    // Perform text detection
    const [result] = await vision.textDetection({
      image: { content: imageBuffer }
    });

    const detections = result.textAnnotations;
    if (!detections || detections.length === 0) {
      console.log('No text detected, returning fallback');
      return {
        supplier: 'No Text Detected',
        items: [{
          description: 'Unable to extract text from image',
          quantity: 1,
          unitPrice: 0,
          unit: 'each'
        }]
      };
    }

    const fullText = detections[0].description;
    console.log(`Extracted text length: ${fullText.length} characters`);
    
    // Parse the text
    const parsedData = parseInvoiceText(fullText);
    
    return {
      supplier: parsedData.supplier,
      items: parsedData.items,
      extractedTextLength: fullText.length
    };

  } catch (visionError) {
    console.error('Google Vision error:', visionError);
    throw new Error(`OCR processing failed: ${visionError.message}`);
  }
}

function parseInvoiceText(text) {
  console.log('Parsing invoice text...');
  
  const lines = text.split('\n').filter(line => line.trim());
  console.log(`Processing ${lines.length} lines`);
  
  // Find supplier (first meaningful line)
  let supplier = 'Unknown Supplier';
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const line = lines[i].trim();
    if (line.length > 3 && 
        !line.match(/^\d+/) && 
        !line.toLowerCase().includes('invoice') &&
        !line.toLowerCase().includes('tax') &&
        !line.toLowerCase().includes('date') &&
        !line.match(/^\$/) &&
        !line.match(/\d{2}\/\d{2}\/\d{4}/)) {
      supplier = line;
      console.log(`Found supplier: ${supplier}`);
      break;
    }
  }

  // Parse items - look for price patterns
  const items = [];
  
  // Look for lines with prices
  for (const line of lines) {
    const cleanLine = line.trim();
    
    // Skip headers and totals
    if (cleanLine.toLowerCase().includes('total') ||
        cleanLine.toLowerCase().includes('subtotal') ||
        cleanLine.toLowerCase().includes('gst') ||
        cleanLine.toLowerCase().includes('tax') ||
        cleanLine.toLowerCase().includes('invoice') ||
        cleanLine.length < 3) {
      continue;
    }

    // Pattern: anything with a price
    const priceMatch = cleanLine.match(/(.+?)\s*\$?(\d+(?:\.\d{2})?)/);
    if (priceMatch) {
      const [, description, priceStr] = priceMatch;
      const price = parseFloat(priceStr);
      
      if (price > 0.50 && price < 10000) { // Reasonable price range
        // Look for quantity in the description
        const qtyMatch = description.match(/(\d+(?:\.\d+)?)\s*(.+)/);
        if (qtyMatch) {
          const [, qtyStr, desc] = qtyMatch;
          items.push({
            description: desc.trim(),
            quantity: parseFloat(qtyStr),
            unitPrice: price,
            unit: 'each'
          });
        } else {
          items.push({
            description: description.trim(),
            quantity: 1,
            unitPrice: price,
            unit: 'each'
          });
        }
        
        console.log(`Found item: ${description.trim()} - $${price}`);
      }
    }
  }

  // If no items found, create one from any price
  if (items.length === 0) {
    const priceMatches = text.match(/\$(\d+(?:\.\d{2})?)/g);
    if (priceMatches && priceMatches.length > 0) {
      const price = parseFloat(priceMatches[0].replace('$', ''));
      items.push({
        description: 'Invoice Item',
        quantity: 1,
        unitPrice: price,
        unit: 'each'
      });
    } else {
      // Absolute fallback
      items.push({
        description: 'Text extracted but no prices found',
        quantity: 1,
        unitPrice: 0,
        unit: 'each'
      });
    }
  }

  console.log(`Parsed ${items.length} items`);
  return { supplier, items };
}

function parseMultipartForm(body, boundary) {
  const parts = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const bodyBuffer = Buffer.from(body, 'base64');
  
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
  
  for (const section of sections) {
    if (section.length === 0) continue;
    
    const headerEndIndex = section.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) continue;
    
    const headers = section.slice(0, headerEndIndex).toString();
    const content = section.slice(headerEndIndex + 4);
    
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    
    const fieldName = nameMatch[1];
    
    if (fieldName === 'file') {
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/);
      
      parts.file = {
        filename: filenameMatch ? filenameMatch[1] : 'uploaded_file',
        contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
        data: content
      };
    } else {
      parts[fieldName] = content.toString().trim();
    }
  }
  
  return parts;
}
