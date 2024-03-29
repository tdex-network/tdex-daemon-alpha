import {
  networks,
  ECPair,
  payments,
  Psbt,
  confidential,
  Transaction,
} from 'liquidjs-lib';
//Libs
import { coinselect, calculateFees, UtxoInterface } from '../utils';
//Types
import { ECPairInterface } from 'liquidjs-lib/types/ecpair';
import { Network } from 'liquidjs-lib/types/networks';

export interface WalletInterface {
  keyPair: ECPairInterface;
  privateKey: string;
  publicKey: string;
  address: string;
  script: string;
  network: Network;
  updateTx(
    psbtBase64: string,
    inputs: Array<any>,
    inputAmount: number,
    outputAmount: number,
    inputAsset: string,
    outputAsset: string
  ): { base64: string; selectedUtxos: UtxoInterface[] };
  payFees(
    psbtBase64: string,
    utxos: Array<any>
  ): { base64: string; selectedUtxos: UtxoInterface[] };
  sign(psbtBase64: string): string;
}

export default class Wallet implements WalletInterface {
  keyPair: ECPairInterface;
  privateKey: string;
  publicKey: string;
  address: string;
  script: string;
  network: Network;

  constructor(args: any) {
    const { keyPair }: { keyPair: ECPairInterface } = args;

    this.keyPair = keyPair;
    this.privateKey = this.keyPair.privateKey!.toString('hex');
    this.publicKey = this.keyPair.publicKey!.toString('hex');

    this.network = this.keyPair.network;
    const { address, output } = payments.p2wpkh({
      pubkey: this.keyPair.publicKey,
      network: this.network,
    });
    this.address = address!;
    this.script = output!.toString('hex');
  }

  updateTx(
    psbtBase64: string,
    inputs: Array<any>,
    inputAmount: number,
    outputAmount: number,
    inputAsset: string,
    outputAsset: string
  ): { base64: string; selectedUtxos: UtxoInterface[] } {
    if (inputs.length === 0) throw new Error('Swap: No utxos available');

    let psbt: Psbt;
    try {
      psbt = Psbt.fromBase64(psbtBase64);
    } catch (ignore) {
      throw new Error('Invalid psbt');
    }

    inputs = inputs.filter((utxo: any) => utxo.asset === inputAsset);
    const { unspents, change } = coinselect(inputs, inputAmount);

    unspents.forEach((i: any) =>
      psbt.addInput({
        // if hash is string, txid, if hash is Buffer, is reversed compared to txid
        hash: i.txid,
        index: i.vout,
        //The scriptPubkey and the value only are needed.
        witnessUtxo: {
          script: Buffer.from(this.script, 'hex'),
          asset: Buffer.concat([
            Buffer.from('01', 'hex'), //prefix for unconfidential asset
            Buffer.from(inputAsset, 'hex').reverse(),
          ]),
          value: confidential.satoshiToConfidentialValue(i.value),
          nonce: Buffer.from('00', 'hex'),
        },
      } as any)
    );

    psbt.addOutput({
      script: Buffer.from(this.script, 'hex'),
      value: confidential.satoshiToConfidentialValue(outputAmount),
      asset: Buffer.concat([
        Buffer.from('01', 'hex'), //prefix for unconfidential asset
        Buffer.from(outputAsset, 'hex').reverse(),
      ]),
      nonce: Buffer.from('00', 'hex'),
    });

    if (change > 0) {
      psbt.addOutput({
        script: Buffer.from(this.script, 'hex'),
        value: confidential.satoshiToConfidentialValue(change),
        asset: Buffer.concat([
          Buffer.from('01', 'hex'), //prefix for unconfidential asset
          Buffer.from(inputAsset, 'hex').reverse(),
        ]),
        nonce: Buffer.from('00', 'hex'),
      });
    }

    return { base64: psbt.toBase64(), selectedUtxos: unspents };
  }

  payFees(
    psbtBase64: string,
    utxos: any[]
  ): { base64: string; selectedUtxos: UtxoInterface[] } {
    if (utxos.length === 0) throw new Error('Fees: No utxos available');

    const psbt = Psbt.fromBase64(psbtBase64);
    const tx = Transaction.fromBuffer(psbt.data.getTransaction());
    const { fees } = calculateFees(tx.ins.length + 1, tx.outs.length + 2, {
      satPerByte: 0.2,
    });
    const encodedAsset = Buffer.concat([
      Buffer.alloc(1, 1),
      Buffer.from(this.network.assetHash, 'hex').reverse(),
    ]);

    const { unspents, change } = coinselect(utxos, fees);
    unspents.forEach((input) =>
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        witnessUtxo: {
          nonce: Buffer.from('00', 'hex'),
          value: confidential.satoshiToConfidentialValue(input.value),
          script: Buffer.from(this.script, 'hex'),
          asset: encodedAsset,
        },
      } as any)
    );

    psbt.addOutput({
      asset: encodedAsset,
      script: Buffer.alloc(0),
      value: confidential.satoshiToConfidentialValue(fees),
      nonce: Buffer.alloc(1, 0),
    });

    if (change > 0) {
      psbt.addOutput({
        asset: encodedAsset,
        script: Buffer.from(this.script, 'hex'),
        value: confidential.satoshiToConfidentialValue(change),
        nonce: Buffer.alloc(1, 0),
      });
    }

    return { base64: psbt.toBase64(), selectedUtxos: unspents };
  }

  sign(psbtBase64: string): string {
    let psbt: Psbt;
    try {
      psbt = Psbt.fromBase64(psbtBase64);
    } catch (ignore) {
      throw new Error('Invalid psbt');
    }

    psbt.data.inputs.forEach((p, i) => {
      if (p.witnessUtxo!.script.toString('hex') === this.script) {
        psbt.signInput(i, this.keyPair);
        if (!psbt.validateSignaturesOfInput(i))
          throw new Error('Invalid signature');
      }
    });

    return psbt.toBase64();
  }

  static toHex(psbtBase64: string): string {
    let psbt: Psbt;
    try {
      psbt = Psbt.fromBase64(psbtBase64);
    } catch (ignore) {
      throw new Error('Invalid psbt');
    }

    //Let's finalize all inputs
    psbt.validateSignaturesOfAllInputs();
    psbt.finalizeAllInputs();

    return psbt.extractTransaction().toHex();
  }

  static createTx(network?: string): string {
    const _network = network ? (networks as any)[network] : networks.liquid;
    const psbt = new Psbt({ network: _network });
    return psbt.toBase64();
  }
}

export function fromWIF(wif: string, network: Network): WalletInterface {
  try {
    const keyPair = ECPair.fromWIF(wif, network);
    return new Wallet({ keyPair });
  } catch (ignore) {
    throw new Error('Invalid keypair');
  }
}
