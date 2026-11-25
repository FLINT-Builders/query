<script setup lang="ts">
import {
  computed,
  inject,
  onMounted,
  onScopeDispose,
  ref,
  watchEffect,
} from 'vue'
import {
  VUE_QUERY_CLIENT,
  onlineManager,
  useQueryClient,
} from '@tanstack/vue-query'
import { TanstackQueryDevtools } from '@tanstack/query-devtools'
import type { QueryClient } from '@tanstack/vue-query'
import type { DevtoolsOptions } from './types'

const props = defineProps<DevtoolsOptions>()

const div = ref<HTMLElement>()
// Injection is only available during setup, so the context client is captured
// here for when the `client` prop is unset later on.
const contextClient = props.client
  ? inject<QueryClient | undefined>(VUE_QUERY_CLIENT, undefined)
  : useQueryClient()
const client = computed(() => {
  const resolved = props.client || contextClient
  if (!resolved) {
    throw new Error(
      "No 'queryClient' found in Vue context, use 'VueQueryPlugin' to properly initialize the library.",
    )
  }
  return resolved
})
const devtools = new TanstackQueryDevtools({
  client: client.value,
  queryFlavor: 'Vue Query',
  version: '5',
  onlineManager,
  buttonPosition: props.buttonPosition,
  position: props.position,
  initialIsOpen: props.initialIsOpen,
  errorTypes: props.errorTypes,
  styleNonce: props.styleNonce,
  shadowDOMTarget: props.shadowDOMTarget,
  hideDisabledQueries: props.hideDisabledQueries,
  theme: props.theme,
})

watchEffect(() => {
  devtools.setClient(client.value)
})

watchEffect(() => {
  devtools.setButtonPosition(props.buttonPosition || 'bottom-right')
  devtools.setPosition(props.position || 'bottom')
  devtools.setInitialIsOpen(props.initialIsOpen)
  devtools.setErrorTypes(props.errorTypes || [])
  devtools.setTheme(props.theme || 'system')
})

onMounted(() => {
  devtools.mount(div.value as HTMLElement)
  onScopeDispose(() => {
    devtools.unmount()
  })
})
</script>

<template>
  <div class="tsqd-parent-container" ref="div"></div>
</template>
