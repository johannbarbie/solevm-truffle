const { toBytes32, wallets, deployContract, txOverrides } = require('./../helpers/utils');
const assertRevert = require('./../helpers/assertRevert');

const Enforcer = artifacts.require('./Enforcer.sol');
const Verifier = artifacts.require('./Verifier.sol');
const VerifierMock = artifacts.require('./mocks/VerifierMock.sol');

contract('Enforcer', () => {
  const callData = '0xc0ffee';
  const otherCallData = '0xc0ffef';
  const endHash = '0x712bc4532b751c4417b44cf11e2377778433ff720264dc8a47cb1da69d371433';
  const otherEndHash = '0x641db1239a480d87bdb76fc045d5f6a68ad1cbf9b93e3b2c92ea638cff6c2add';
  const executionLength = 100;
  const challengePeriod = 3;
  const timeoutDuration = 0;
  const bondAmount = 999;
  let enforcer;
  let verifier;
  let verifierMock;
  let solver = wallets[0];
  let challenger = wallets[1];

  it('should allow to register and challenge execution', async () => {
    verifier = await deployContract(Verifier, timeoutDuration);
    enforcer = await deployContract(Enforcer, verifier.address, challengePeriod, bondAmount);

    let tx = await verifier.setEnforcer(enforcer.address);
    await tx.wait();

    // register execution and check state
    tx = await enforcer.register(
      enforcer.address, callData, endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );

    tx = await tx.wait();

    // start dispute
    tx = await enforcer.dispute(
      enforcer.address, callData, otherEndHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();

    const disputeId = tx.events[0].args.disputeId;
    const bondBefore = (await enforcer.bonds(enforcer.signer.address)).toNumber();

    // solver wins if nothing happened until claimTimeout
    tx = await verifier.claimTimeout(disputeId, txOverrides);
    await tx.wait();

    // check that the challenger bond got slashed (solver & challenger are both the same in this test)
    const bondAfter = (await enforcer.bonds(enforcer.signer.address)).toNumber();
    assert.equal(bondAfter, bondBefore - bondAmount, 'bondAfter');
  });

  it('should have correct information', async () => {
    verifierMock = await deployContract(VerifierMock);
    enforcer = await deployContract(Enforcer, verifierMock.address, challengePeriod, bondAmount);
    let tx = await verifierMock.setEnforcer(enforcer.address);
    await tx.wait();

    assert.equal(await enforcer.verifier(), verifierMock.address, 'verifier address not match');
    assert.equal(await enforcer.challengePeriod(), challengePeriod, 'challenge period not match');
    assert.equal(await enforcer.bondAmount(), bondAmount, 'bond amount not match');
  });

  // register
  it('not allow registration without bond', async () => {
    let tx = enforcer.register(
      enforcer.address, callData, endHash, executionLength,
      { value: 0, gasLimit: 0xfffffffffffff }
    );

    await assertRevert(tx);
  });

  it('allow registration of new execution', async () => {
    const solverBond = await enforcer.bonds(solver.address);
    let tx = await enforcer.register(
      enforcer.address, callData, endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();
    const event = tx.events[0].args;
    const executionId = event.executionId;

    assert.equal(event.solver, solver.address, 'solver address not match');
    assert.equal(event.codeContractAddress, enforcer.address, 'code contract address not match');
    assert.equal(event._callData, callData, 'call data not match');
    assert.deepEqual(await enforcer.bonds(solver.address), solverBond.add(bondAmount), 'bond amount not update');

    const execution = await enforcer.executions(executionId);

    assert.isTrue(execution.startBlock.gt(0), 'start block not set');
    assert.equal(execution.endHash, endHash, 'endHash not match');
    assert.equal(execution.executionDepth, executionLength, 'execution length not match');
    assert.equal(execution.solver, solver.address, 'solver address not match');
  });

  it('not allow registration of the same execution', async () => {
    let tx = enforcer.register(
      enforcer.address, callData, endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    await assertRevert(tx);
  });

  // dispute
  it('not allow dispute with nonexistent execution', async () => {
    let tx = enforcer.dispute(
      enforcer.address, otherCallData, endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );

    await assertRevert(tx);
  });

  it('not allow dispute without bond', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x01', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    await tx.wait();

    tx = enforcer.dispute(
      enforcer.address, '0x01', otherEndHash, executionLength,
      { value: 0, gasLimit: 0xfffffffffffff }
    );
    await assertRevert(tx);
  });

  it('not allow dispute after challenge period', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x02', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    await tx.wait();

    for (let i = 0; i < challengePeriod; i++) {
      tx = await verifierMock.dummy();
      await tx.wait();
    }

    tx = enforcer.dispute(
      enforcer.address, '0x02', otherEndHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    await assertRevert(tx);
  });

  it('allow dispute with valid execution', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x03', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();
    const executionId = tx.events[0].args.executionId;

    const challengerBond = await enforcer.bonds(challenger.address);
    tx = await enforcer.connect(challenger).dispute(
      enforcer.address, '0x03', otherEndHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();

    assert.equal(tx.events[0].args.executionId, executionId, 'dispute incorrect execution');
    assert.deepEqual(
      await enforcer.bonds(challenger.address),
      challengerBond.add(bondAmount),
      'bond amount not update'
    );
  });

  // result
  it('not allow submit not by verifier', async () => {
    let tx = enforcer.connect(challenger).result(
      toBytes32('invalid', 64),
      true,
      challenger.address,
      { gasLimit: 0xfffffffffffff });
    await assertRevert(tx);
  });

  it('not allow submit result of nonexistent execution', async () => {
    let tx = verifierMock.submitResult(
      toBytes32('invalid', 64),
      true,
      challenger.address,
      { gasLimit: 0xfffffffffffff });
    await assertRevert(tx);
  });

  it('not allow submit result of execution after challenge period', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x04', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();
    const executionId = tx.events[0].args.executionId;

    for (let i = 0; i < challengePeriod; i++) {
      tx = await verifierMock.dummy();
      await tx.wait();
    }

    tx = verifierMock.submitResult(executionId, false, challenger.address, { gasLimit: 0xfffffffffffff });
    await assertRevert(tx);
  });

  it('allow submit result of valid execution and slash solver', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x05', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();
    const executionId = tx.events[0].args.executionId;

    const solverBond = await enforcer.bonds(solver.address);
    tx = await verifierMock.submitResult(executionId, false, challenger.address, { gasLimit: 0xfffffffffffff });
    tx = await tx.wait();
    assert.deepEqual(await enforcer.bonds(solver.address), solverBond.sub(bondAmount), 'solver not slashed');
    const execution = await enforcer.executions(executionId);
    assert.equal(execution.startBlock, 0, 'execution not deleted');
  });

  it('allow submit result of valid execution and slash challenger', async () => {
    let tx = await enforcer.register(
      enforcer.address, '0x06', endHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();
    const executionId = tx.events[0].args.executionId;

    tx = await enforcer.connect(challenger).dispute(
      enforcer.address, '0x06', otherEndHash, executionLength,
      { value: bondAmount, gasLimit: 0xfffffffffffff }
    );
    tx = await tx.wait();

    const challengerBond = await enforcer.bonds(challenger.address);
    tx = await verifierMock.submitResult(executionId, true, challenger.address, { gasLimit: 0xfffffffffffff });
    tx = await tx.wait();
    assert.deepEqual(
      await enforcer.bonds(challenger.address),
      challengerBond.sub(bondAmount),
      'challenger not slashed');
  });
});
