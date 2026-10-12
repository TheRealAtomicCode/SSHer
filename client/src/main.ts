import { OhVueIcon } from 'oh-vue-icons';
import { createApp } from 'vue';
import App from './App.vue';
import './icons';
import './style.css';

createApp(App).component('v-icon', OhVueIcon).mount('#app');
