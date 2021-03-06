const { expect } = require('chai');
const { expectRevert, BN, constants } = require('@openzeppelin/test-helpers');
const { registry } = require('./helpers/Constants');
const Decimal = require('decimal.js');

const ContractRegistry = artifacts.require('ContractRegistry');
const BancorFormula = artifacts.require('BancorFormula');
const BancorNetwork = artifacts.require('BancorNetwork');
const DSToken = artifacts.require('DSToken');
const ConverterRegistry = artifacts.require('ConverterRegistry');
const ConverterRegistryData = artifacts.require('ConverterRegistryData');
const ConverterFactory = artifacts.require('ConverterFactory');
const LiquidityPoolV1ConverterFactory = artifacts.require('TestLiquidityPoolV1ConverterFactory');
const LiquidityPoolV1Converter = artifacts.require('TestLiquidityPoolV1Converter');
const LiquidityProtection = artifacts.require('TestLiquidityProtection');
const LiquidityProtectionStore = artifacts.require('LiquidityProtectionStore');

const INITIAL_AMOUNT = 1000000;

function decimalToInteger(value, decimals) {
    const parts = [...value.split('.'), ''];
    return parts[0] + parts[1].padEnd(decimals, '0');
}

function percentageToPPM(value) {
    return decimalToInteger(value.replace('%', ''), 4);
}

const FULL_PPM = percentageToPPM('100%');
const HALF_PPM = percentageToPPM('50%');

contract('LiquidityProtectionTokenRate', (accounts) => {
    const convert = async (sourceToken, targetToken, amount) => {
        await sourceToken.approve(bancorNetwork.address, amount);
        const path = [sourceToken.address, poolToken.address, targetToken.address];
        await bancorNetwork.convertByPath(path, amount, 1, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS, 0);
    };

    let bancorNetwork;
    let liquidityProtection;
    let reserveToken1;
    let reserveToken2;
    let poolToken;
    let converter;
    let time;

    before(async () => {
        const contractRegistry = await ContractRegistry.new();
        const converterRegistry = await ConverterRegistry.new(contractRegistry.address);
        const converterRegistryData = await ConverterRegistryData.new(contractRegistry.address);

        bancorNetwork = await BancorNetwork.new(contractRegistry.address);
        liquidityProtection = await LiquidityProtection.new(
            accounts[0],
            accounts[0],
            accounts[0],
            contractRegistry.address
        );

        const liquidityPoolV1ConverterFactory = await LiquidityPoolV1ConverterFactory.new();
        const converterFactory = await ConverterFactory.new();
        await converterFactory.registerTypedConverterFactory(liquidityPoolV1ConverterFactory.address);

        const bancorFormula = await BancorFormula.new();
        await bancorFormula.init();

        await contractRegistry.registerAddress(registry.CONVERTER_FACTORY, converterFactory.address);
        await contractRegistry.registerAddress(registry.CONVERTER_REGISTRY, converterRegistry.address);
        await contractRegistry.registerAddress(registry.CONVERTER_REGISTRY_DATA, converterRegistryData.address);
        await contractRegistry.registerAddress(registry.BANCOR_FORMULA, bancorFormula.address);
        await contractRegistry.registerAddress(registry.BANCOR_NETWORK, bancorNetwork.address);

        reserveToken1 = await DSToken.new('RT1', 'RT1', 18);
        reserveToken2 = await DSToken.new('RT2', 'RT2', 18);
        await reserveToken1.issue(accounts[0], new BN('1'.padEnd(30, '0')));
        await reserveToken2.issue(accounts[0], new BN('1'.padEnd(30, '0')));

        await converterRegistry.newConverter(
            1,
            'PT',
            'PT',
            18,
            FULL_PPM,
            [reserveToken1.address, reserveToken2.address],
            [HALF_PPM, HALF_PPM]
        );
        poolToken = await DSToken.at(await converterRegistry.getAnchor(0));
        converter = await LiquidityPoolV1Converter.at(await poolToken.owner());
        await converter.acceptOwnership();
        time = await converter.currentTime();
    });

    for (let minutesElapsed = 1; minutesElapsed <= 10; minutesElapsed += 1) {
        for (let convertPortion = 1; convertPortion <= 10; convertPortion += 1) {
            for (let maxDeviation = 1; maxDeviation <= 10; maxDeviation += 1) {
                it(`minutesElapsed = ${minutesElapsed}, convertPortion = ${convertPortion}%, maxDeviation = ${maxDeviation}%`, async () => {
                    await liquidityProtection.setAverageRateMaxDeviation(percentageToPPM(`${maxDeviation}%`));
                    await reserveToken1.approve(converter.address, INITIAL_AMOUNT);
                    await reserveToken2.approve(converter.address, INITIAL_AMOUNT);
                    await converter.addLiquidity(
                        [reserveToken1.address, reserveToken2.address],
                        [INITIAL_AMOUNT, INITIAL_AMOUNT],
                        1
                    );
                    await convert(reserveToken1, reserveToken2, (INITIAL_AMOUNT * convertPortion) / 100);
                    time = time.add(new BN(minutesElapsed * 60));
                    await converter.setTime(time);
                    const averageRate = await converter.recentAverageRate(reserveToken1.address);
                    const actualRate = await Promise.all(
                        [reserveToken2, reserveToken1].map((reserveToken) => reserveToken.balanceOf(converter.address))
                    );
                    const min = Decimal(actualRate[0].toString())
                        .div(actualRate[1].toString())
                        .mul(100 - maxDeviation)
                        .div(100);
                    const max = Decimal(actualRate[0].toString())
                        .div(actualRate[1].toString())
                        .mul(100)
                        .div(100 - maxDeviation);
                    const mid = Decimal(averageRate[0].toString()).div(averageRate[1].toString());
                    if (min.lte(mid) && mid.lte(max)) {
                        const reserveTokenRate = await liquidityProtection.averageRateTest(
                            poolToken.address,
                            reserveToken1.address
                        );
                        expect(reserveTokenRate[0]).to.be.bignumber.equal(averageRate[0]);
                        expect(reserveTokenRate[1]).to.be.bignumber.equal(averageRate[1]);
                    } else {
                        await expectRevert(
                            liquidityProtection.averageRateTest(poolToken.address, reserveToken1.address),
                            'ERR_INVALID_RATE'
                        );
                    }
                    await converter.removeLiquidity(
                        await poolToken.balanceOf(accounts[0]),
                        [reserveToken1.address, reserveToken2.address],
                        [1, 1]
                    );
                });
            }
        }
    }
});
