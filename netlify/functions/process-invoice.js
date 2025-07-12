// netlify/functions/process-invoice.js - Hybrid Azure + Abacus.ai Solution
const { DocumentAnalysisClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");
const axios = require('axios');

// Configuration
const AZURE_CONFIG = {
  endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  key: process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY
};

const ABACUS_CONFIG = {
  endpoint: 'https://api.abacus.ai/v1/deployments/14fa057fbc/execute',
  apiKey: process.env.ABACUS_API_KEY
};

// Business context for Wild Octave Organics
const BUSINESS_CONTEXT = {
  shop_name: "Wild Octave Organics",
  typical_suppliers: [
    "Biodynamic Supplies", 
    "Organic Wholesalers", 
    "Natural Foods Ltd",
    "Pure Earth Trading",
    "Green Valley Distributors"
  ],
  product_categories: {
    organic: { markup: 0.45, keywords: ["organic", "bio", "certified organic"] },
    supplements: { markup: 0.50, keywords: ["vitamin", "supplement", "mineral", "probiotic"] },
    bulk: { markup: 0.35, keywords: ["bulk", "25kg", "20kg", "wholesale"] },
    cosmetics: { markup: 0.55, keywords: ["cream", "oil", "soap", "shampoo"] },
    groceries: { markup: 0.40, keywords: [] }
  },
  gst_rate: 0.10,
  currency: "AUD"
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
    
    // Validate environment variables
    if (!AZURE_CONFIG.endpoint || !AZURE_CONFIG.key) {
      throw new Error('Azure Document Intelligence credentials not configured');
    }
    
    if (!ABACUS_CONFIG.apiKey) {
      throw new Error('Abacus.ai API key not configured');
    }

    // Parse the uploaded file
    console.log('📄 Parsing uploaded file...');
    const parts = parseMultipartForm(event.body, event.headers['content-type']);
    const file = parts.file;
    
    if (!file) {
      throw new Error('No file uploaded');
    }

    console.log(`Processing: ${file.filename}, size: ${file.data.length} bytes`);

    // Step 1: Extract data with Azure Document Intelligence
    console.log('🔍 Extracting data with Azure Document Intelligence...');
    const azureData = await extractWithAzure(file);
    
    // Step 2: Enhance with Abacus.ai business logic
    console.log('🧠 Applying business logic with Abacus.ai...');
    const enhancedData = await enhanceWithAbacus(azureData);
    
    // Step 3: Format for your existing UI
    console.log('✅ Formatting results...');
    const formattedResult = formatForUI(enhancedData);
    
    console.log('🎉 Processing complete!');
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
        details: 'Check function logs for more information'
      })
    };
  }
};

async function extractWithAzure(file) {
  try {
    // Initialize Azure client
    const client = new DocumentAnalysisClient(
      AZURE_CONFIG.endpoint,
      new AzureKeyCredential(AZURE_CONFIG.key)
    );

    // Convert file data to proper format
    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    
    // Start analysis
    const poller = await client.beginAnalyzeDocument(
      "prebuilt-invoice",
      imageBuffer,
      {
        locale: "en-AU"
      }
    );

    // Wait for completion
    const result = await poller.pollUntilDone();
    
    if (!result.documents || result.documents.length === 0) {
      throw new Error("No invoice data extracted from document");
    }

    const invoice = result.documents[0];
    return transformAzureData(invoice);

  } catch (error) {
    console.error('Azure extraction error:', error);
    // Fallback to basic text extraction if Azure fails
    return createFallbackData(file);
  }
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

async function enhanceWithAbacus(azureData) {
  try {
    const prompt = `Process this azure_data: ${JSON.stringify(azureData)}`;
    
    const response = await axios.post(ABACUS_CONFIG.endpoint, {
      input_text: prompt
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ABACUS_CONFIG.apiKey}`
      },
      timeout: 30000
    });

    if (response.data && response.data.response) {
      try {
        const enhancedData = JSON.parse(response.data.response);
        return enhancedData;
      } catch (parseError) {
        console.warn('Failed to parse Abacus.ai response, using fallback');
        return applyFallbackLogic(azureData);
      }
    } else {
      throw new Error('Invalid response from Abacus.ai');
    }

  } catch (error) {
    console.warn('Abacus.ai enhancement failed, using fallback logic:', error.message);
    return applyFallbackLogic(azureData);
  }
}

function applyFallbackLogic(azureData) {
  console.log('Applying fallback business logic...');
  
  const enhancedLineItems = azureData.line_items.map(item => {
    const category = categorizeProduct(item.description);
    const markupPercent = BUSINESS_CONTEXT.product_categories[category]?.markup || 0.40;
    const retailPrice = item.unit_cost * (1 + markupPercent);
    
    return {
      ...item,
      category: category,
      markup: 1 + markupPercent,
      retailPrice: retailPrice,
      suggested_markup_percent: markupPercent * 100,
      review_required: !item.product_code || item.product_code.length < 3
    };
  });
  
  return {
    ...azureData,
    line_items: enhancedLineItems,
    processing_notes: [
      "Data extracted with Azure Document Intelligence",
      "Fallback business logic applied",
      "Consider checking Abacus.ai connection"
    ]
  };
}

function categorizeProduct(description) {
  if (!description) return 'groceries';
  
  const desc = description.toLowerCase();
  
  for (const [category, config] of Object.entries(BUSINESS_CONTEXT.product_categories)) {
    if (category === 'groceries') continue;
    
    for (const keyword of config.keywords) {
      if (desc.includes(keyword.toLowerCase())) {
        return category;
      }
    }
  }
  
  return 'groceries';
}

function formatForUI(enhancedData) {
  // Format data to match your existing UI expectations
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
    processingNotes: enhancedData.processing_notes || ['Processed with hybrid Azure + Abacus.ai'],
    summary: {
      totalItems: items.length,
      totalCost: items.reduce((sum, item) => sum + item.costExGST, 0),
      totalRetail: items.reduce((sum, item) => sum + item.retailPrice, 0)
    }
  };
}

function createFallbackData(file) {
  // Fallback if Azure completely fails
  return {
    supplier: { name: "Processing Error" },
    line_items: [{
      description: "Unable to process invoice - check file format",
      quantity: 1,
      unit_cost: 0,
      unit: "each"
    }]
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
