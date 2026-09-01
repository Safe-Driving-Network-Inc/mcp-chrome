/* eslint-disable */
// js/similarity.worker.js
importScripts('../libs/ort.min.js'); // adjust the path to match your file layout

// Global worker state
let session = null;
let modelPathInternal = null;
let ortEnvConfigured = false;
let sessionOptions = null;
let modelInputNames = null; // stores the model's input names

// Reused TypedArray buffers, to cut down on allocations
let reusableBuffers = {
  inputIds: null,
  attentionMask: null,
  tokenTypeIds: null,
};

// Performance stats
let workerStats = {
  totalInferences: 0,
  totalInferenceTime: 0,
  averageInferenceTime: 0,
  memoryAllocations: 0,
};

// Configure the ONNX Runtime environment (once only)
function configureOrtEnv(numThreads = 1, executionProviders = ['wasm']) {
  if (ortEnvConfigured) return;
  try {
    ort.env.wasm.numThreads = numThreads;
    ort.env.wasm.simd = true; // enable SIMD where possible
    ort.env.wasm.proxy = false; // inside a worker a proxy is usually unnecessary
    ort.env.logLevel = 'warning'; // 'verbose', 'info', 'warning', 'error', 'fatal'
    ortEnvConfigured = true;

    sessionOptions = {
      executionProviders: executionProviders,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
      // executionMode: 'sequential' // inside a worker a task usually runs sequentially
    };
  } catch (error) {
    console.error('Worker: Failed to configure ORT environment', error);
    throw error; // rethrow so the main thread finds out
  }
}

async function initializeModel(modelPathOrData, numThreads, executionProviders) {
  try {
    configureOrtEnv(numThreads, executionProviders); // make sure the environment is configured

    if (!modelPathOrData) {
      throw new Error('Worker: Model path or data is not provided.');
    }

    // Check if input is ArrayBuffer (cached model data) or string (URL path)
    if (modelPathOrData instanceof ArrayBuffer) {
      console.log(
        `Worker: Initializing model from cached ArrayBuffer (${modelPathOrData.byteLength} bytes)`,
      );
      session = await ort.InferenceSession.create(modelPathOrData, sessionOptions);
      modelPathInternal = '[Cached ArrayBuffer]'; // For debugging purposes
    } else {
      console.log(`Worker: Initializing model from URL: ${modelPathOrData}`);
      modelPathInternal = modelPathOrData; // keep the model path for debugging or reloading
      session = await ort.InferenceSession.create(modelPathInternal, sessionOptions);
    }

    // Read the model's input names, to decide whether token_type_ids is needed
    modelInputNames = session.inputNames;
    console.log(`Worker: ONNX session created successfully for model: ${modelPathInternal}`);
    console.log(`Worker: Model input names:`, modelInputNames);

    return { status: 'success', message: 'Model initialized' };
  } catch (error) {
    console.error(`Worker: Model initialization failed:`, error);
    session = null; // clear the session in case it was only partially initialized
    modelInputNames = null;
    // Serialize the error, since an Error object itself may not survive postMessage
    throw new Error(`Worker: Model initialization failed - ${error.message}`);
  }
}

// Optimized buffer management helpers
function getOrCreateBuffer(name, requiredLength, type = BigInt64Array) {
  if (!reusableBuffers[name] || reusableBuffers[name].length < requiredLength) {
    reusableBuffers[name] = new type(requiredLength);
    workerStats.memoryAllocations++;
  }
  return reusableBuffers[name];
}

// Optimized batch inference
async function runBatchInference(batchData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};
    const batchSize = batchData.dims.input_ids[0];
    const seqLength = batchData.dims.input_ids[1];

    // Optimization: reuse buffers to cut down on allocations
    const inputIdsLength = batchData.input_ids.length;
    const attentionMaskLength = batchData.attention_mask.length;

    // Reuse or create the BigInt64Array buffer
    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    // Fill the data in bulk (avoids a map pass)
    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(batchData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(batchData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      batchData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      batchData.dims.attention_mask,
    );

    // Handle token_type_ids - only supply it when the model needs it
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (batchData.token_type_ids && batchData.dims.token_type_ids) {
        const tokenTypeIdsLength = batchData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(batchData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          batchData.dims.token_type_ids,
        );
      } else {
        // Create a default all-zero token_type_ids
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          batchData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    // Run batch inference
    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    // Use Transferable Objects to speed up the data hand-off
    const outputData = new Float32Array(outputTensor.data);

    // Update the stats
    workerStats.totalInferences += batchSize; // a batch counts as several inferences
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData,
        dims: outputTensor.dims,
        batchSize: batchSize,
        seqLength: seqLength,
      },
      transferList: [outputData.buffer],
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
        batchSize: batchSize,
      },
    };
  } catch (error) {
    console.error('Worker: Batch inference failed:', error);
    throw new Error(`Worker: Batch inference failed - ${error.message}`);
  }
}

async function runInference(inputData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};

    // Optimization: reuse buffers to cut down on allocations
    const inputIdsLength = inputData.input_ids.length;
    const attentionMaskLength = inputData.attention_mask.length;

    // Reuse or create the BigInt64Array buffer
    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    // Fill the data (avoids a map pass)
    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(inputData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(inputData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      inputData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      inputData.dims.attention_mask,
    );

    // Handle token_type_ids - only supply it when the model needs it
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (inputData.token_type_ids && inputData.dims.token_type_ids) {
        const tokenTypeIdsLength = inputData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(inputData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          inputData.dims.token_type_ids,
        );
      } else {
        // Create a default all-zero token_type_ids
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          inputData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    // Use Transferable Objects to speed up the data hand-off
    const outputData = new Float32Array(outputTensor.data);

    // Update the stats
    workerStats.totalInferences++;
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData, // return the Float32Array directly
        dims: outputTensor.dims,
      },
      transferList: [outputData.buffer], // mark as a transferable object
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
      },
    };
  } catch (error) {
    console.error('Worker: Inference failed:', error);
    throw new Error(`Worker: Inference failed - ${error.message}`);
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'init':
        // Support both modelPath (URL string) and modelData (ArrayBuffer)
        const modelInput = payload.modelData || payload.modelPath;
        await initializeModel(modelInput, payload.numThreads, payload.executionProviders);
        self.postMessage({ id, type: 'init_complete', status: 'success' });
        break;
      case 'infer':
        const result = await runInference(payload);
        // Use Transferable Objects to speed up the data hand-off
        self.postMessage(
          {
            id,
            type: 'infer_complete',
            status: 'success',
            payload: result.output,
            stats: result.stats,
          },
          result.transferList || [],
        );
        break;
      case 'batchInfer':
        const batchResult = await runBatchInference(payload);
        // Use Transferable Objects to speed up the data hand-off
        self.postMessage(
          {
            id,
            type: 'batchInfer_complete',
            status: 'success',
            payload: batchResult.output,
            stats: batchResult.stats,
          },
          batchResult.transferList || [],
        );
        break;
      case 'getStats':
        self.postMessage({
          id,
          type: 'stats_complete',
          status: 'success',
          payload: workerStats,
        });
        break;
      case 'clearBuffers':
        // Release the buffers to free memory
        reusableBuffers = {
          inputIds: null,
          attentionMask: null,
          tokenTypeIds: null,
        };
        workerStats.memoryAllocations = 0;
        self.postMessage({
          id,
          type: 'clear_complete',
          status: 'success',
          payload: { message: 'Buffers cleared' },
        });
        break;
      default:
        console.warn(`Worker: Unknown message type: ${type}`);
        self.postMessage({
          id,
          type: 'error',
          status: 'error',
          payload: { message: `Unknown message type: ${type}` },
        });
    }
  } catch (error) {
    // Send the error as a plain object, since an Error object may not serialize correctly
    self.postMessage({
      id,
      type: `${type}_error`, // e.g. 'init_error' or 'infer_error'
      status: 'error',
      payload: {
        message: error.message,
        stack: error.stack, // optional, useful for debugging
        name: error.name,
      },
    });
  }
};
