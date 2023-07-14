import { generateMnemonic } from '@confio/relayer/build/lib/helpers';
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import { cosmos, getSigningCosmosClient, getSigningOsmosisClient } from '../../src/codegen';
import { useChain, waitUntil } from '../src';
import './setup.test';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';

describe('Governance tests for osmosis', () => {
  let protoSigner, aminoSigner, denom, address;
  let chainInfo,
    getCoin,
    getGenesisMnemonic,
    getRpcEndpoint,
    creditFromFaucet;

  // Variables used accross testcases
  let queryClient;
  let proposalId;
  let genesisAddress;

  beforeAll(async () => {
    ({
      chainInfo,
      getCoin,
      getStargateClient,
      getGenesisMnemonic,
      getRpcEndpoint,
      creditFromFaucet
    } = useChain('osmosis'));
    denom = getCoin().base;

    const mnemonic = generateMnemonic();
    // Initialize wallet
    protoSigner = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: chainInfo.chain.bech32_prefix
    });
    aminoSigner = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: chainInfo.chain.bech32_prefix
    });
    address = (await protoSigner.getAccounts())[0].address;

    // Create custom cosmos interchain client
    queryClient = await cosmos.ClientFactory.createRPCQueryClient({
      rpcEndpoint: getRpcEndpoint()
    });

    // Transfer osmosis to address
    await creditFromFaucet(address);
  }, 200000);

  it('check address has tokens', async () => {
    const { balance } = await queryClient.cosmos.bank.v1beta1.balance({
      address,
      denom
    });

    expect(balance.amount).toEqual('10000000000');
  }, 10000);

  it('submit a txt proposal', async () => {
    const signingClient = await getSigningCosmosClient({
      rpcEndpoint: getRpcEndpoint(),
      signer: protoSigner
    });

    const contentMsg = cosmos.gov.v1beta1.TextProposal.fromPartial({
      title: 'Test Proposal',
      description: 'Test text proposal for the e2e testing'
    });

    // Stake half of the tokens
    const msg = cosmos.gov.v1beta1.MessageComposer.withTypeUrl.submitProposal({
      proposer: address,
      initialDeposit: [
        {
          amount: '1000000',
          denom: denom
        }
      ],
      content: {
        typeUrl: '/cosmos.gov.v1beta1.TextProposal',
        value: cosmos.gov.v1beta1.TextProposal.encode(contentMsg).finish()
      }
    });

    const fee = {
      amount: [
        {
          denom,
          amount: '100000'
        }
      ],
      gas: '550000'
    };

    const result = await signingClient.signAndBroadcast(address, [msg], fee);
    assertIsDeliverTxSuccess(result);

    // Get proposal id from log events
    const proposalIdEvent = result.events.find(
      (event) => event.type === 'submit_proposal'
    );
    proposalId = proposalIdEvent.attributes.find(
      (attr) => attr.key === 'proposal_id'
    ).value;

    // eslint-disable-next-line no-undef
    expect(BigInt(proposalId)).toBeGreaterThan(BigInt(0));
  }, 200000);

  it('query proposal', async () => {
    const result = await queryClient.cosmos.gov.v1beta1.proposal({
      proposalId: BigInt(proposalId)
    });

    expect(result.proposal.proposalId.toString()).toEqual(proposalId);
  }, 10000);

  it.todo('vote on proposal using amino');

  it('vote on proposal from genesis address', async () => {
    // create genesis address signing client
    const mnemonic = await getGenesisMnemonic();
    // TODO: this is PROTO NOT AMINO!!!
    const genesisWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: chainInfo.chain.bech32_prefix
    });
    genesisAddress = (await genesisWallet.getAccounts())[0].address;

    const genesisSigningClient = await getSigningCosmosClient({
      rpcEndpoint: getRpcEndpoint(),
      signer: genesisWallet
    });

    // Vote on proposal from genesis mnemonic address
    const msg = cosmos.gov.v1beta1.MessageComposer.withTypeUrl.vote({
      proposalId: BigInt(proposalId),
      voter: genesisAddress,
      option: cosmos.gov.v1beta1.VoteOption.VOTE_OPTION_YES
    });

    const fee = {
      amount: [
        {
          denom,
          amount: '100000'
        }
      ],
      gas: '550000'
    };

    const result = await genesisSigningClient.signAndBroadcast(
      genesisAddress,
      [msg],
      fee
    );
    assertIsDeliverTxSuccess(result);
  }, 10000);

  it('verify vote', async () => {
    const { vote } = await queryClient.cosmos.gov.v1beta1.vote({
      proposalId: BigInt(proposalId),
      voter: genesisAddress
    });

    expect(vote.proposalId.toString()).toEqual(proposalId);
    expect(vote.voter).toEqual(genesisAddress);
    expect(vote.option).toEqual(cosmos.gov.v1beta1.VoteOption.VOTE_OPTION_YES);
  }, 10000);

  it('wait for voting period to end', async () => {
    // wait for the voting period to end
    const { proposal } = await queryClient.cosmos.gov.v1beta1.proposal({
      proposalId: BigInt(proposalId)
    });

    await expect(waitUntil(proposal.votingEndTime)).resolves.not.toThrow();
  }, 200000);

  it('verify proposal passed', async () => {
    const { proposal } = await queryClient.cosmos.gov.v1beta1.proposal({
      proposalId: BigInt(proposalId)
    });

    expect(proposal.status).toEqual(
      cosmos.gov.v1beta1.ProposalStatus.PROPOSAL_STATUS_PASSED
    );
  }, 10000);
});
