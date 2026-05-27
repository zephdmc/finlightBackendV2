const queue = [];
let processing = false;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Add email job to queue
 */
const addToEmailQueue = (job) => {
    queue.push({
        ...job,
        retries: 0,
        maxRetries: job.maxRetries || 3,
    });

    // ALWAYS attempt processing (safe re-entry)
    setImmediate(processQueue);
};
// const addToEmailQueue = (job) => {
//     queue.push({
//         ...job,
//         retries: 0,
//         maxRetries: job.maxRetries || 3,
//     });

//     processQueue();
// };

/**
 * Process queue sequentially
 */
const processQueue = async () => {
    if (processing) return;
    processing = true;

    try {
        while (queue.length > 0) {
            const job = queue.shift();

            try {
                await job.task();
                console.log(`✅ Email sent: ${job.name}`);
            } catch (error) {
                console.error(`❌ Email failed: ${job.name}`, error.message);

                if (job.retries < job.maxRetries) {
                    job.retries++;
                    console.log(`🔁 Retrying (${job.retries}/${job.maxRetries})`);

                    await delay(2000);
                    queue.push(job);
                } else {
                    console.error(`💀 Email permanently failed: ${job.name}`);
                }
            }
        }
    } finally {
        processing = false;
    }
};

module.exports = {
    addToEmailQueue,
};