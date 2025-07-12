// netlify/functions/process-invoice.js - Azure Only Version (Reliable)
const { DocumentAnalysisClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");

// Configuration
const AZURE_CONFIG = {
  endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  key: process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY
};

// Business rules for Wild Octave Organics
const BUSINESS_RULES = {
  markup_rules: {
    'Organic': 0.45,      // 45% markup
    'Supplements': 0.50,   // 50% markup  
    'Bulk': 0.35,         // 35% markup
    'Cosmetics': 0.55,    // 55% markup
    'Groceries': 0.40     // 40% default markup
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
    console.log('🔄 Starting Azure-powered invoice processing...');
    
    // Validate Azure credentials
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

    // Parse uploaded file
    console.log('📄 Parsing uploaded file...');
    const parts = parseMultipartForm(event.body, event.headers['content-type']);
    const file = parts.file;
    
    if (!file) {
      throw new Error('No file uploaded');
    }

    console.log(`Processing: ${file.filename}, size: ${file.data.length} bytes, type: ${file.contentType}`);

    // Extract with Azure Document Intelligence
    console.log('🔍 Extracting with Azure Document Intelligence...');
    const azureData = await extractWithAzure(file);
    
    // Apply business rules (local logic)
    console.log('🧠 Applying Wild Octave business rules...');
    const enhancedData = applyBusinessRules(azureData);
    
    // Format for your UI
    const formattedResult = formatForUI(enhancedData);
    
    console.log('🎉 Processing complete!', {
      supplier: formattedResult.supplier,
      itemCount: formattedResult.items.length,
      totalCost: formattedResult.summary?.totalCost || 0
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
        timestamp: new Date().toISOString()
      })
    };
  }
};

async function extractWithAzure(file) {
  try {
    console.log('Initializing Azure Document Intelligence client...');
    const client = new DocumentAnalysisClient(
      AZURE_CONFIG.endpoint,
      new AzureKeyCredential(AZURE_CONFIG.key)
    );

    const imageBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    console.log(`Processing ${imageBuffer.length} byte file`);
    
    // Try invoice model first
    console.log('Attempting prebuilt-invoice model...');
    try {
      const invoicePoller = await client.beginAnalyzeDocument("prebuilt-invoice", imageBuffer, {
        locale: "en-AU"
      });
      
      const invoiceResult = await invoicePoller.pollUntilDone();
      
      if (invoiceResult.documents && invoiceResult.documents.length > 0) {
        console.log('✅ Invoice model successful');
        return transformAzureInvoiceData(invoiceResult.documents[0]);
      } else {
        console.log('⚠️ Invoice model found no structured data, trying text extraction...');
        throw new Error('No invoice structure detected');
      }
    } catch (invoiceError) {
      console.log('Invoice model failed, trying basic text extraction:', invoiceError.message);
      
      // Fallback to basic text extraction
      const textPoller = await client.beginAnalyzeDocument("prebuilt-read", imageBuffer);
      const textResult = await textPoller.pollUntilDone();
      
      if (textResult.content && textResult.content.length > 20) {
        console.log(`✅ Text extraction successful: ${textResult.content.length} characters`);
        return parseTextToInvoiceData(textResult.content);
      } else {
        throw new Error("No readable text found in document");
      }
    }

  } catch (error) {
    console.error('Azure extraction failed:', error);
    return createFallbackData(file, error.message);
  }
}

function transformAzureInvoiceData(invoice) {
  const fields = invoice.fields || {};
  
  console.log('Transforming Azure invoice data...');
  console.log('Available fields:', Object.keys(fields));
  
  // Extract supplier info
  const supplier = {
    name: fields.VendorName?.content || fields.MerchantName?.content || "Unknown Supplier",
    address: fields.VendorAddress?.content || fields.MerchantAddress?.content || "",
    abn: fields.VendorTaxId?.content || ""
  };
  
  // Extract invoice details
  const invoice_details = {
    number: fields.InvoiceId?.content || "",
    date: fields.InvoiceDate?.content || "",
    due_date: fields.DueDate?.content || "",
    po_number: fields.PurchaseOrder?.content || ""
  };
  
  // Extract line items
  const line_items = extractLineItemsFromAzure(fields.Items?.valueArray || []);
  
  // Extract totals
  const totals = {
    subtotal_ex_gst: fields.SubTotal?.valueNumber || 0,
    gst_amount: fields.TotalTax?.valueNumber || 0,
    total_inc_gst: fields.InvoiceTotal?.valueNumber || 0
  };
  
  console.log(`Extracted: supplier="${supplier.name}", ${line_items.length} items, total=$${totals.total_inc_gst}`);
  
  return {
    supplier,
    invoice: invoice_details,
    line_items,
    totals,
    extraction_method: "Azure Invoice Model"
  };
}

function extractLineItemsFromAzure(azureItems) {
  if (!azureItems || azureItems.length === 0) {
    console.log('No line items found in Azure invoice model');
    return [];
  }
  
  console.log(`Processing ${azureItems.length} line items from Azure...`);
  
  return azureItems.map((item, index) => {
    const itemFields = item.valueObject || {};
    
    const description = itemFields.Description?.content || 
                       itemFields.ProductCode?.content || 
                       `Item ${index + 1}`;
    const quantity = itemFields.Quantity?.valueNumber || 1;
    const unitPrice = itemFields.UnitPrice?.valueNumber || 0;
    const lineTotal = itemFields.Amount?.valueNumber || (quantity * unitPrice);
    
    console.log(`Item ${index + 1}: "${description}" - Qty: ${quantity}, Unit: $${unitPrice}, Total: $${lineTotal}`);
    
    return {
      line_number: index + 1,
      product_code: itemFields.ProductCode?.content || "",
      description: description,
      quantity: quantity,
      unit_cost: unitPrice,
      line_total_ex_gst: lineTotal,
      gst_amount: lineTotal * 0.10,
      line_total_inc_gst: lineTotal * 1.10,
      unit: itemFields.Unit?.content || "each"
    };
  });
}

function parseTextToInvoiceData(text) {
  console.log('Parsing text to invoice data...');
  
  const lines = text.split('\n').filter(line => line.trim().length > 2);
  console.log(`Processing ${lines.length} text lines`);
  
  // Find supplier (usually in first few lines)
  let supplier = 'Unknown Supplier';
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim();
    if (line.length > 5 && 
        !line.match(/^\d/) && 
        !line.toLowerCase().includes('invoice') &&
        !line.toLowerCase().includes('tax') &&
        !line.toLowerCase().includes('total') &&
        !line.toLowerCase().includes('date') &&
        !line.match(/^\$/) &&
        !line.match(/\d{2}\/\d{2}\/\d{4}/)) {
      supplier = line;
      console.log(`Found supplier: "${supplier}"`);
      break;
    }
  }

  // Extract line items from text
  const items = [];
  const processedLines = new Set();
  
  for (let i = 0; i < lines.length; i++) {
    if (processedLines.has(i)) continue;
    
    const line = lines[i].trim();
    
    // Skip headers, totals, and metadata
    if (line.toLowerCase().includes('total') ||
        line.toLowerCase().includes('subtotal') ||
        line.toLowerCase().includes('gst') ||
        line.toLowerCase().includes('tax') ||
        line.toLowerCase().includes('invoice') ||
        line.toLowerCase().includes('date') ||
        line.toLowerCase().includes('abn') ||
        line.length < 3) {
      continue;
    }

    // Look for price patterns
    const priceMatches = line.match(/\$?([\d,]+\.?\d*)/g);
    if (priceMatches && priceMatches.length > 0) {
      const prices = priceMatches.map(p => parseFloat(p.replace(/[$,]/g, '')));
      const mainPrice = prices.find(p => p > 1 && p < 10000);
      
      if (mainPrice) {
        const description = line.replace(/\$?[\d,]+\.?\d*/g, '').trim() || `Line Item ${items.length + 1}`;
        
        // Look for quantity in description
        const qtyMatch = description.match(/(\d+)\s*x?\s*(.+)/i);
        let quantity = 1;
        let cleanDescription = description;
        
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1]);
          cleanDescription = qtyMatch[2].trim();
        }
        
        items.push({
          line_number: items.length + 1,
          product_code: '',
          description: cleanDescription,
          quantity: quantity,
          unit_cost: mainPrice / quantity,
          line_total_ex_gst: mainPrice,
          gst_amount: mainPrice * 0.10,
          line_total_inc_gst: mainPrice * 1.10,
          unit: 'each'
        });
        
        console.log(`Extracted item: "${cleanDescription}" - Qty: ${quantity}, Price: $${mainPrice}`);
        processedLines.add(i);
      }
    }
  }
  
  // If no items found, create a placeholder
  if (items.length === 0) {
    items.push({
      line_number: 1,
      product_code: '',
      description: 'Text extracted but no clear line items found',
      quantity: 1,
      unit_cost: 0,
      line_total_ex_gst: 0,
      gst_amount: 0,
      line_total_inc_gst: 0,
      unit: 'each'
    });
  }
  
  const totalExGst = items.reduce((sum, item) => sum + item.line_total_ex_gst, 0);
  const totalGst = items.reduce((sum, item) => sum + item.gst_amount, 0);
  
  console.log(`Text parsing result: ${items.length} items, total: $${totalExGst + totalGst}`);
  
  return {
    supplier: { name: supplier },
    invoice: { number: '', date: '', due_date: '', po_number: '' },
    line_items: items,
    totals: {
      subtotal_ex_gst: totalExGst,
      gst_amount: totalGst,
      total_inc_gst: totalExGst + totalGst
    },
    extraction_method: "Text Parsing"
  };
}

function createFallbackData(file, errorMessage) {
  console.log('Creating fallback data due to extraction failure');
  
  return {
    supplier: { name: "Processing Error" },
    invoice: { number: '', date: '', due_date: '', po_number: '' },
    line_items: [{
      line_number: 1,
      product_code: '',
      description: `Unable to process ${file.filename} - ${errorMessage}`,
      quantity: 1,
      unit_cost: 0,
      line_total_ex_gst: 0,
      gst_amount: 0,
      line_total_inc_gst: 0,
      unit: 'each'
    }],
    totals: { subtotal_ex_gst: 0, gst_amount: 0, total_inc_gst: 0 },
    extraction_method: "Error Fallback"
  };
}

function applyBusinessRules(azureData) {
  console.log('Applying Wild Octave Organics business rules...');
  
  const enhancedLineItems = azureData.line_items.map(item => {
    const category = categorizeProduct(item.description);
    const markupPercent = BUSINESS_RULES.markup_rules[category];
    const retailPriceExGst = item.unit_cost * (1 + markupPercent);
    const retailPriceIncGst = retailPriceExGst * 1.10;
    
    const enhanced = {
      ...item,
      category: category,
      markup: 1 + markupPercent,
      retailPrice: retailPriceIncGst,
      suggested_markup_percent: markupPercent * 100,
      review_required: !item.product_code || item.product_code.length < 2 || item.unit_cost === 0,
      notes: []
    };
    
    // Add review notes
    if (!item.product_code || item.product_code.length < 2) {
      enhanced.notes.push("Missing product code");
    }
    if (item.unit_cost === 0) {
      enhanced.notes.push("No unit cost detected");
    }
    if (item.description.length < 5) {
      enhanced.notes.push("Description unclear");
    }
    
    console.log(`Enhanced: "${item.description}" -> Category: ${category}, Markup: ${markupPercent * 100}%, Retail: $${retailPriceIncGst.toFixed(2)}`);
    
    return enhanced;
  });
  
  return {
    ...azureData,
    line_items: enhancedLineItems,
    processing_notes: [
      `Data extracted with Azure Document Intelligence (${azureData.extraction_method})`,
      "Wild Octave Organics business rules applied",
      `${enhancedLineItems.length} items processed`,
      `${enhancedLineItems.filter(item => item.review_required).length} items flagged for review`
    ]
  };
}

function categorizeProduct(description) {
  if (!description) return 'Groceries';
  
  const desc = description.toLowerCase();
  
  // Organic products
  if (desc.includes('organic') || desc.includes('bio') || desc.includes('certified')) {
    return 'Organic';
  }
  
  // Supplements
  if (desc.includes('vitamin') || desc.includes('supplement') || 
      desc.includes('mineral') || desc.includes('probiotic') ||
      desc.includes('capsule') || desc.includes('tablet')) {
    return 'Supplements';
  }
  
  // Bulk items
  if (desc.includes('bulk') || desc.includes('25kg') || 
      desc.includes('20kg') || desc.includes('wholesale') ||
      desc.includes('sack') || desc.includes('bag')) {
    return 'Bulk';
  }
  
  // Cosmetics
  if (desc.includes('cream') || desc.includes('oil') || 
      desc.includes('soap') || desc.includes('shampoo') ||
      desc.includes('lotion') || desc.includes('balm')) {
    return 'Cosmetics';
  }
  
  return 'Groceries';
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

  const summary = {
    totalItems: items.length,
    totalCost: items.reduce((sum, item) => sum + (item.costExGST * item.quantity), 0),
    totalRetail: items.reduce((sum, item) => sum + (item.retailPrice * item.quantity), 0),
    itemsNeedingReview: enhancedData.line_items.filter(item => item.review_required).length
  };

  return {
    supplier: enhancedData.supplier?.name || 'Unknown Supplier',
    items: items,
    processingNotes: enhancedData.processing_notes || ['Processed with Azure Document Intelligence'],
    summary: summary,
    extractionMethod: enhancedData.extraction_method,
    reviewItems: enhancedData.line_items.filter(item => item.review_required)
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
