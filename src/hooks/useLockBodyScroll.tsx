import { useEffect } from 'react';

const useLockBodyScroll = (condition: boolean) => {
    useEffect(() => {
        if (condition) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }

        return () => {
            document.body.style.overflow = '';
        };
    }, [condition]);
};

export default useLockBodyScroll;
