import {DlpReadDBListMode, DlpReadDBListRequest, NetSyncConnection} from '..';

export async function run({dlpConnection}: NetSyncConnection) {
  const readDbListResp = await dlpConnection.execute(
    DlpReadDBListRequest.with({
      mode: DlpReadDBListMode.LIST_RAM | DlpReadDBListMode.LIST_MULTIPLE,
    })
  );
  const dbNames = readDbListResp.metadataList.map(({name}) => name);
  console.log(dbNames.join('\n'));
}