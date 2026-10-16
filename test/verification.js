const { runVerification } = require('./verificationRunner');

process.exitCode = runVerification();
