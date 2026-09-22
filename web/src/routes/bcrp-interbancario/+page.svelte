<script lang="ts">
  import DatasetPage from '$lib/DatasetPage.svelte'
  import { datasetPage } from '$lib/datasets'

  const dataset = datasetPage('bcrp')
</script>

<svelte:head>
  <title>Tipo de Cambio Interbancario BCRP · public-business-data</title>
</svelte:head>

<DatasetPage {dataset} />
