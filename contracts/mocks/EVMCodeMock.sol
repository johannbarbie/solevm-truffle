pragma solidity ^0.5.2;
pragma experimental ABIEncoderV2;

import "../EVMCode.slb";


contract EVMCodeMock {
    using EVMCode for EVMCode.Code;

    function testFindFragment(EVMCode.RawCode[] memory rawCodes, uint codeLength, uint pos)
    public view returns (EVMCode.DataNode memory res) {
        EVMCode.Code memory code = EVMCode.fromArray(rawCodes, codeLength);
        res = code.findFragment(pos);
    }

    function testToUint(EVMCode.RawCode[] memory rawCodes, uint codeLength, uint pos, uint length)
    public view returns (uint res) {
        EVMCode.Code memory code = EVMCode.fromArray(rawCodes, codeLength);
        res = code.toUint(pos, length);
    }

    function testToBytes(EVMCode.RawCode[] memory rawCodes, uint codeLength, uint pos, uint length)
    public view returns (bytes memory res) {
        EVMCode.Code memory code = EVMCode.fromArray(rawCodes, codeLength);
        res = code.toBytes(pos, length);
    }
}
