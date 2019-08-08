'use strict';

const ethers = require('ethers');

const HydratedRuntime = require('./HydratedRuntime.js');
const Merkelizer = require('./Merkelizer.js');
const ProofHelper = require('./ProofHelper.js');
const FragmentTree = require('./FragmentTree');
const { ZERO_HASH } = require('./constants.js');

module.exports = class ExecutionPoker {
  constructor (enforcer, verifier, wallet, gasLimit = 0xfffffffffffff, logTag = 'unkn') {
    this.enforcer = enforcer.connect(wallet);
    this.verifier = verifier.connect(wallet);
    this.wallet = wallet;
    this.gasLimit = gasLimit;
    this.logTag = logTag;
    // TODO: this needs to be garbage collected
    this.taskParams = {};
    this.taskCallData = {};
    this.disputes = {};
    this.solutions = {};

    this.enforcer.on(
      this.enforcer.filters.Requested(),
      async (taskHash, parameters, callData, tx) => {
        const params = {
          origin: parameters[0],
          target: parameters[1],
          blockHash: parameters[2],
          blockNumber: parameters[3],
          time: parameters[4],
          txGasLimit: parameters[5],
          customEnvironmentHash: parameters[6],
          codeHash: parameters[7],
          dataHash: parameters[8],
        };
        this.taskParams[taskHash] = params;
        this.taskCallData[params.dataHash] = callData;

        const receipt = await tx.getTransactionReceipt();

        if (receipt.from === this.wallet.address) {
          this.log('task request', { taskHash, params });
          this.registerExecution(taskHash, params);
        } else {
          this.log('task requested', { taskHash, params });
        }
      }
    );

    this.enforcer.on(
      this.enforcer.filters.Registered(),
      async (taskHash, solverPathRoot, executionDepth, resultBytes, tx) => {
        const receipt = await tx.getTransactionReceipt();

        if (receipt.from === this.wallet.address) {
          this.log('execution result registered', taskHash);
        } else {
          this.validateExecution(taskHash, solverPathRoot, executionDepth, resultBytes);
        }
      }
    );

    this.enforcer.on(
      this.enforcer.filters.Slashed(),
      (execId, addr, tx) => {
        if (addr === this.wallet.address) {
          this.onSlashed(execId);
        }
      }
    );

    this.enforcer.on(
      this.enforcer.filters.DisputeInitialised(),
      (disputeId, execId, tx) => {
        let sol = this.solutions[execId];

        if (sol) {
          this.log('new dispute for', execId);
          this.initDispute(disputeId, sol);
        }
      }
    );

    this.verifier.on(
      this.verifier.filters.DisputeNewRound(),
      (disputeId, timeout, solverPath, challengerPath, tx) => {
        let o = this.disputes[disputeId];

        if (o) {
          this.log(`dispute(${disputeId}) new round`);
          this.submitRound(disputeId);
        }
      }
    );
  }

  onSlashed (execId) {
  }

  log (...args) {
    console.log(this.logTag, ':', ...args);
  }

  async requestExecution (evmParameter, callData) {
    let tx = await this.enforcer.request(evmParameter, callData);

    tx = await tx.wait();

    const taskHash = tx.events[0].args.taskHash;

    return { taskHash, evmParameter };
  }

  async registerExecution (taskHash, evmParams) {
    const res = await this.computeCall(evmParams);
    const { resultProof, returnData } = res.merkle.computeResultProof();
    const bondAmount = await this.enforcer.bondAmount();

    this.log('registering execution:', res.steps.length, 'steps');

    // paranoia, better safe than sorry
    if (!res.merkle.verifyResultProof(resultProof, returnData, res.merkle.root.hash)) {
      throw new Error('Computed resultProof is invalid. Please file a bug report.');
    }

    let tx = await this.enforcer.register(
      taskHash,
      res.merkle.root.hash,
      resultProof,
      returnData,
      { value: bondAmount }
    );

    tx = await tx.wait();

    const evt = tx.events[0].args;
    const executionId = ethers.utils.solidityKeccak256(
      ['bytes32', 'bytes32'],
      [taskHash, evt.solverPathRoot]
    );

    this.solutions[executionId] = res;
  }

  async validateExecution (taskHash, solverHash, executionDepth, resultBytes) {
    const executionId = ethers.utils.solidityKeccak256(
      ['bytes32', 'bytes32'],
      [taskHash, solverHash]
    );
    this.log('validating execution result', executionId);

    // TODO: MerkleTree resizing
    // check execution length and resize tree if necessary
    const taskParams = this.taskParams[taskHash];
    const res = await this.computeCall(taskParams);

    // TODO: handle the bigger case too
    if (executionDepth < res.merkle.depth) {
      // scale down
      res.merkle.tree[0] = res.merkle.tree[0].slice(0, 2 ** (executionDepth.toNumber() - 1));
      // recalculate tree
      res.merkle.recal();
    }

    const challengerHash = res.merkle.root.hash;

    this.log('solverHash', solverHash);
    this.log('challengerHash', challengerHash);

    if (solverHash !== challengerHash || this.alwaysChallenge) {
      const bondAmount = await this.enforcer.bondAmount();

      let tx = await this.enforcer.dispute(
        solverHash,
        challengerHash,
        taskParams,
        { value: bondAmount, gasLimit: this.gasLimit }
      );

      tx = await tx.wait();

      let disputeId = tx.events[0].topics[1];

      this.initDispute(disputeId, res);
      return;
    }

    this.log('same execution result');
  }

  initDispute (disputeId, res) {
    this.log('initDispute', disputeId);

    let obj = {
      merkle: res.merkle,
      depth: res.merkle.depth,
      computationPath: res.merkle.root,
      codeFragmentTree: res.codeFragmentTree,
    };

    this.disputes[disputeId] = obj;

    this.submitRound(disputeId);
  }

  async submitRound (disputeId) {
    const obj = this.disputes[disputeId];

    if (obj.computationPath.isLeaf) {
      this.log('reached leaves');
      this.log('submitting for l=' +
        obj.computationPath.left.hash + ' r=' + obj.computationPath.right.hash);

      await this.submitProof(disputeId, obj);
      return;
    }

    const dispute = await this.verifier.disputes(disputeId);
    const targetPath = this.wallet.address === dispute.challengerAddr ? dispute.challengerPath : dispute.solverPath;
    const path = this.wallet.address === dispute.challengerAddr ? dispute.challenger : dispute.solver;
    const nextPath = obj.merkle.getNode(targetPath);

    if (!nextPath) {
      this.log('submission already made by another party');
      obj.computationPath = obj.merkle.getPair(path.left, path.right);
      return;
    }

    if (obj.computationPath.left.hash === targetPath) {
      this.log('goes left from ' +
        obj.computationPath.hash.substring(2, 6) + ' to ' +
        obj.computationPath.left.hash.substring(2, 6)
      );
    } else if (obj.computationPath.right.hash === targetPath) {
      this.log('goes right from ' +
        obj.computationPath.hash.substring(2, 6) + ' to ' +
        obj.computationPath.right.hash.substring(2, 6)
      );
    }

    obj.computationPath = nextPath;

    let witnessPath;

    if (dispute.witness !== ZERO_HASH) {
      const path = obj.merkle.getNode(dispute.witness);

      witnessPath = { left: path.left.hash, right: path.right.hash };
    } else {
      witnessPath = { left: ZERO_HASH, right: ZERO_HASH };
    }

    let tx = await this.verifier.respond(
      disputeId,
      {
        left: obj.computationPath.left.hash,
        right: obj.computationPath.right.hash,
      },
      witnessPath,
      { gasLimit: this.gasLimit }
    );

    tx = await tx.wait();

    this.log('gas used', tx.gasUsed.toString(), tx.hash);
  }

  async submitProof (disputeId, disputeObj) {
    const args = ProofHelper.constructProof(disputeObj.computationPath, disputeObj);

    this.log('submitting proof - proofs', args.proofs);
    this.log('submitting proof - executionState', args.executionInput);

    let tx = await this.verifier.submitProof(
      disputeId,
      args.proofs,
      args.executionInput,
      { gasLimit: this.gasLimit }
    );

    tx = await tx.wait();

    this.log('submitting proof - gas used', tx.gasUsed.toString());

    return tx;
  }

  async computeCall (evmParams) {
    let bytecode = await this.getCodeForParams(evmParams);
    let data = await this.getDataForParams(evmParams);
    let code = [];
    let len = bytecode.length;

    for (let i = 2; i < len;) {
      code.push(bytecode.substring(i, i += 2));
    }

    let codeFragmentTree;
    // code is not on chain-🍕
    if (!evmParams.codeHash.endsWith('000000000000000000000000')) {
      codeFragmentTree = new FragmentTree().run(bytecode);
    }

    const runtime = new HydratedRuntime();
    const steps = await runtime.run({ code, data });
    const merkle = new Merkelizer().run(steps, bytecode, data, evmParams.customEnvironmentHash);

    return { steps, merkle, codeFragmentTree };
  }

  async getCodeForParams (evmParams) {
    const addr = evmParams.codeHash.substring(0, 42);
    return this.wallet.provider.getCode(addr);
  }

  async getDataForParams (evmParams) {
    return this.taskCallData[evmParams.dataHash];
  }
};
