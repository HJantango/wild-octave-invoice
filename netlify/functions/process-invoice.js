// netlify/functions/process-invoice.js - Debug Version
const { DocumentAnalysisClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");
const axios = require('axios');

// Configuration with debug logging
const AZURE_CONFIG = {
  endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  key: process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY
};

const ABACUS_CONFIG = {
  endpoint: 'https://api.abacus.ai/api/v0/getApiEndpoint',
  apiKey: process.env.ABACUS_API_KEY || 's2_6f60d28791c94b7a99c837c0a8dc09d2',
  deploymentId: '14fa057fbc',
  deploymentToken: '041ee184499141258533dcca6d3a9aa0a6'
};

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
    console.log('🔄 Starting hybrid invoice processing...');
    
    // Debug environment variables
    console.log('Environment check:', {
      azureEndpoint: AZURE_CONFIG.endpoint ? 'SET' : 'MISSING',
      azureKey: AZURE_CONFIG.key ? 'SET' : 'MISSING',
      abacusKey: ABACUS_CONFIG.apiKey ? 'SET' : 'MISSING'
    });
    
    // Validate environment variables
    if (!AZURE_CONFIG.endpoint || !AZURE_CONFIG.key) {
      console.error('❌ Azure credentials missing');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Azure Document Intelligence credentials not configured',
          debug: {
            endpoint: AZURE_CONFIG.endpoint ? 'SET' : 'MISSING',
            key: AZURE_CONFIG.key ? 'SET' : 'MISSING'
          }
        })
      };
    }

    // Parse the uploaded file
    console.log('📄 Parsing uploaded file...');
    const parts = parseMultipartForm(event.body, event.headers['content-type']);
    const file = parts.file;
    
    if (!file) {
      throw new Error('No file uploaded');
    }

    console.log(`Processing: ${file.filename}, size: ${file.data.length} bytes, type: ${file.contentType}`);

    // Try Azure first, with detailed error handling
    let azureData;
    try {
      console.log('🔍 Attempting Azure Document Intelligence...');
      azureData = await extractWithAzure(file);
      console.log('✅ Azure extraction successful');
    } catch (azureError) {
      console.error('❌ Azure extraction failed:', azureError.message);
      // Try basic OCR fallback
      azureData = await tryBasicOCR(file);
    }
    
    // Apply business logic (try Abacus.ai, fallback to local logic)
    let enhancedData;
    try {
      if (ABACUS_CONFIG.apiKey) {
        console.log('🧠 Trying Abacus.ai enhancement...');
        enhancedData = await enhanceWithAbacus(azureData);
        console.log('✅ Abacus.ai enhancement successful');
      } else {
        console.log('⚠️ No Abacus.ai key, using fallback logic');
        enhancedData = applyFallbackLogic(azureData);
      }
    } catch (abacusError) {
      console.error('❌ Abacus.ai enhancement failed:', abacusError.message);
      enhancedData = applyFallbackLogic(azureData);
    }
    
    // Format for UI
    const formattedResult = formatForUI(enhancedData);
    
    console.log('🎉 Processing complete!', {
      supplier: formattedResult.supplier,
      itemCount: formattedResult.items.length
    });
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(formattedResult)
    };

  } catch (error) {
    console.error('❌ Invoice processing error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        details: 'Check function logs for more information',
        debug: {
          azureConfigured: !!(AZURE_CONFIG.endpoint && AZURE_CONFIG.key),
          abacusConfigured: !!ABACUS_CONFIG.apiKey
        }
      })
    };
  }
};

async function extractWithAzure(file) {
  try {
    console.log('Initializing Azure client...');
    const client = new DocumentAnalysisClient(
      AZURE_CONFIG.endpoint,
      new AzureKeyCredential(AZURE_CONFIG.key)
    );

    // Convert file data
    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    console.log(`Image buffer prepared: ${imageBuffer.length} bytes`);
    
    // Try different models based on file type
    let modelId = "prebuilt-invoice";
    if (file.contentType && file.contentType.includes('image')) {
      console.log('Image file detected, trying invoice model...');
    } else if (file.filename && file.filename.toLowerCase().endsWith('.pdf')) {
      console.log('PDF file detected, trying invoice model...');
    }
    
    console.log(`Using model: ${modelId}`);
    
    // Start analysis
    const poller = await client.beginAnalyzeDocument(
      modelId,
      imageBuffer,
      {
        locale: "en-AU"
      }
    );

    console.log('Waiting for Azure analysis to complete...');
    const result = await poller.pollUntilDone();
    
    console.log('Azure analysis complete:', {
      documentsFound: result.documents?.length || 0,
      pagesAnalyzed: result.pages?.length || 0
    });
    
    if (!result.documents || result.documents.length === 0) {
      console.log('No structured data found, trying text extraction...');
      
      // Try basic text extraction if invoice model fails
      const textPoller = await client.beginAnalyzeDocument("prebuilt-read", imageBuffer);
      const textResult = await textPoller.pollUntilDone();
      
      if (textResult.content) {
        console.log(`Text extracted: ${textResult.content.length} characters`);
        return parseTextToInvoiceData(textResult.content);
      } else {
        throw new Error("No text could be extracted from document");
      }
    }

    const invoice = result.documents[0];
    return transformAzureData(invoice);

  } catch (error) {
    console.error('Azure extraction detailed error:', error);
    throw error;
  }
}

async function tryBasicOCR(file) {
  console.log('Trying basic OCR fallback...');
  
  try {
    const client = new DocumentAnalysisClient(
      AZURE_CONFIG.endpoint,
      new AzureKeyCredential(AZURE_CONFIG.key)
    );

    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    
    // Use basic read model
    const poller = await client.beginAnalyzeDocument("prebuilt-read", imageBuffer);
    const result = await poller.pollUntilDone();
    
    if (result.content && result.content.length > 10) {
      console.log(`Basic OCR successful: ${result.content.length} characters`);
      return parseTextToInvoiceData(result.content);
    } else {
      throw new Error("Basic OCR failed to extract readable text");
    }
    
  } catch (error) {
    console.error('Basic OCR failed:', error);
    return createMinimalFallback(file);
  }
}

function parseTextToInvoiceData(text) {
  console.log('Parsing extracted text to invoice data...');
  
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const supplier = lines.find(line => 
    line.length > 5 && 
    !line.match(/^\d/) && 
    !line.toLowerCase().includes('invoice') &&
    !line.toLowerCase().includes('total')
  ) || 'Unknown Supplier';
  
  // Look for price patterns
  const items = [];
  const priceRegex = /\$?(\d+\.?\d*)/g;
  
  for (const line of lines) {
    const prices = line.match(priceRegex);
    if (prices && prices.length > 0) {
      const price = parseFloat(prices[0].replace('$', ''));
      if (price > 1 && price < 10000) {
        const description = line.replace(/\$?[\d.]+/g, '').trim() || 'Invoice Item';
        items.push({
          line_number: items.length + 1,
          product_code: '',
          description: description,
          quantity: 1,
          unit_cost: price,
          line_total_ex_gst: price,
          gst_amount: price * 0.10,
          line_total_inc_gst: price * 1.10,
          unit: 'each'
        });
      }
    }
  }
  
  if (items.length === 0) {
    items.push({
      line_number: 1,
      product_code: '',
      description: 'Text extracted but no items identified',
      quantity: 1,
      unit_cost: 0,
      line_total_ex_gst: 0,
      gst_amount: 0,
      line_total_inc_gst: 0,
      unit: 'each'
    });
  }
  
  console.log(`Parsed ${items.length} items from text`);
  
  return {
    supplier: { name: supplier },
    invoice: { number: '', date: '', due_date: '', po_number: '' },
    line_items: items,
    totals: {
      subtotal_ex_gst: items.reduce((sum, item) => sum + item.line_total_ex_gst, 0),
      gst_amount: items.reduce((sum, item) => sum + item.gst_amount, 0),
      total_inc_gst: items.reduce((sum, item) => sum + item.line_total_inc_gst, 0)
    }
  };
}

function transformAzureData(azureInvoice) {
  const fields = azureInvoice.fields || {};
  
  return {
    supplier: {
      name: fields.VendorName?.content || "Unknown Supplier",
      address: fields.VendorAddress?.content || "",
      abn: fields.VendorTaxId?.content || ""
    },
    invoice: {
      number: fields.InvoiceId?.content || "",
      date: fields.InvoiceDate?.content || "",
      due_date: fields.DueDate?.content || "",
      po_number: fields.PurchaseOrder?.content || ""
    },
    line_items: extractLineItems(fields.Items?.valueArray || []),
    totals: {
      subtotal_ex_gst: fields.SubTotal?.valueNumber || 0,
      gst_amount: fields.TotalTax?.valueNumber || 0,
      total_inc_gst: fields.InvoiceTotal?.valueNumber || 0
    }
  };
}

function extractLineItems(azureItems) {
  if (azureItems.length === 0) {
    return [{
      line_number: 1,
      product_code: '',
      description: 'No line items detected by Azure',
      quantity: 1,
      unit_cost: 0,
      line_total_ex_gst: 0,
      gst_amount: 0,
      line_total_inc_gst: 0,
      unit: 'each'
    }];
  }
  
  return azureItems.map((item, index) => {
    const itemFields = item.valueObject || {};
    
    const quantity = itemFields.Quantity?.valueNumber || 1;
    const unitPrice = itemFields.UnitPrice?.valueNumber || 0;
    const lineTotal = itemFields.Amount?.valueNumber || (quantity * unitPrice);
    
    return {
      line_number: index + 1,
      product_code: itemFields.ProductCode?.content || "",
      description: itemFields.Description?.content || `Item ${index + 1}`,
      quantity: quantity,
      unit_cost: unitPrice,
      line_total_ex_gst: lineTotal,
      gst_amount: lineTotal * 0.10,
      line_total_inc_gst: lineTotal * 1.10,
      unit: itemFields.Unit?.content || "each"
    };
  });
}

function createMinimalFallback(file) {
  return {
    supplier: { name: "Processing Error" },
    invoice: { number: '', date: '', due_date: '', po_number: '' },
    line_items: [{
      line_number: 1,
      product_code: '',
      description: `Unable to process ${file.filename} - try a clearer image or different format`,
      quantity: 1,
      unit_cost: 0,
      line_total_ex_gst: 0,
      gst_amount: 0,
      line_total_inc_gst: 0,
      unit: 'each'
    }],
    totals: { subtotal_ex_gst: 0, gst_amount: 0, total_inc_gst: 0 }
  };
}

async function enhanceWithAbacus(azureData) {
  try {
    // First get the API endpoint for predictions
    console.log('Getting Abacus.ai API endpoint...');
    const endpointResponse = await axios.get(ABACUS_CONFIG.endpoint, {
      headers: {
        'apiKey': ABACUS_CONFIG.apiKey
      },
      params: {
        deploymentId: ABACUS_CONFIG.deploymentId,
        deploymentToken: ABACUS_CONFIG.deploymentToken
      }
    });

    console.log('Endpoint response:', endpointResponse.data);

    if (!endpointResponse.data.success || !endpointResponse.data.result) {
      throw new Error('Failed to get API endpoint');
    }

    const predictionEndpoint = endpointResponse.data.result;
    console.log('Got prediction endpoint:', predictionEndpoint);

    // Now make the prediction call
    const prompt = `Process this azure_data: ${JSON.stringify(azureData)}`;
    
    const predictionResponse = await axios.post(predictionEndpoint, {
      input_text: prompt
    }, {
      headers: {
        'Content-Type': 'application/json',
        'apiKey': ABACUS_CONFIG.apiKey
      },
      timeout: 30000
    });

    console.log('Prediction response:', predictionResponse.data);

    if (predictionResponse.data && predictionResponse.data.result) {
      try {
        const enhancedData = typeof predictionResponse.data.result === 'string' ? 
          JSON.parse(predictionResponse.data.result) : predictionResponse.data.result;
        return enhancedData;
      } catch (parseError) {
        console.warn('Failed to parse Abacus.ai result:', parseError);
        return applyFallbackLogic(azureData);
      }
    } else if (predictionResponse.data && predictionResponse.data.response) {
      try {
        const enhancedData = JSON.parse(predictionResponse.data.response);
        return enhancedData;
      } catch (parseError) {
        console.warn('Failed to parse Abacus.ai response');
        return applyFallbackLogic(azureData);
      }
    } else {
      console.log('Unexpected Abacus.ai prediction response format:', predictionResponse.data);
      throw new Error('Invalid response from Abacus.ai prediction endpoint');
    }

  } catch (error) {
    console.error('Abacus.ai API error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
}

function applyFallbackLogic(azureData) {
  console.log('Applying fallback business logic...');
  
  const enhancedLineItems = azureData.line_items.map(item => {
    const category = categorizeProduct(item.description);
    const markupPercent = getMarkupForCategory(category);
    const retailPrice = item.unit_cost * (1 + markupPercent);
    
    return {
      ...item,
      category: category,
      markup: 1 + markupPercent,
      retailPrice: retailPrice
    };
  });
  
  return {
    ...azureData,
    line_items: enhancedLineItems
  };
}

function categorizeProduct(description) {
  if (!description) return 'Groceries';
  
  const desc = description.toLowerCase();
  
  if (desc.includes('organic') || desc.includes('bio')) return 'Organic';
  if (desc.includes('vitamin') || desc.includes('supplement')) return 'Supplements';
  if (desc.includes('bulk') || desc.includes('25kg') || desc.includes('20kg')) return 'Bulk';
  if (desc.includes('cream') || desc.includes('oil') || desc.includes('soap')) return 'Cosmetics';
  
  return 'Groceries';
}

function getMarkupForCategory(category) {
  const markups = {
    'Organic': 0.45,
    'Supplements': 0.50,
    'Bulk': 0.35,
    'Cosmetics': 0.55,
    'Groceries': 0.40
  };
  return markups[category] || 0.40;
}

function formatForUI(enhancedData) {
  const items = enhancedData.line_items.map(item => ({
    product: item.description,
    quantity: item.quantity,
    unit: item.unit || 'each',
    costExGST: item.unit_cost,
    category: item.category || 'Groceries',
    markup: item.markup || 1.65,
    retailPrice: item.retailPrice || (item.unit_cost * (item.markup || 1.65))
  }));

  return {
    supplier: enhancedData.supplier?.name || 'Unknown Supplier',
    items: items,
    processingNotes: enhancedData.processing_notes || ['Processed with hybrid system'],
    summary: {
      totalItems: items.length,
      totalCost: items.reduce((sum, item) => sum + (item.costExGST || 0), 0),
      totalRetail: items.reduce((sum, item) => sum + (item.retailPrice || 0), 0)
    }
  };
}

function parseMultipartForm(body, contentType) {
  const boundary = contentType?.split('boundary=')[1];
  if (!boundary) {
    throw new Error('No boundary found in content-type header');
  }

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
